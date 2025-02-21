const fs = require('fs');
const path = require('path');
const EPub = require('epub');
const PDFDocument = require('pdfkit');
const sizeOf = require('image-size');
const util = require('util');
const cheerio = require('cheerio');

if (process.argv.length < 3) {
    console.error('Usage: node index.js <path-to-epub-file>');
    process.exit(1);
}

const epubPath = process.argv[2];
const outputPath = path.join(
    path.dirname(epubPath),
    `${path.basename(epubPath, '.epub')}.pdf`
);

// Create Promise-based epub methods
const getChapterRawAsync = (epub, chapterId) => {
    return new Promise((resolve, reject) => {
        epub.getChapterRaw(chapterId, (err, text) => {
            if (err) reject(err);
            else resolve(text);
        });
    })
};
const getImageAsync = (epub, imageFile) => {
    return new Promise((resolve, reject) => {
        epub.getImage(imageFile, (err, image) => {
            if (err) reject(err);
            else resolve(image);
        });
    });
};

// Main processing function
async function processPDF() {
    try {
        const epub = new EPub(epubPath);
        epub.parse();
        await new Promise((resolve) => epub.on('end', resolve));

        // Create a mapping of file paths to their TOC entries
        const tocMap = new Map();
        if (epub.toc) {
            const processTocItem = (item) => {
                if (item.href) {
                    const href = item.href.split('#')[0];
                    tocMap.set(href, item.title);
                }
                if (item.subitems) {
                    item.subitems.forEach(processTocItem);
                }
            };
            epub.toc.forEach(processTocItem);
        }

        const itemRefs = epub.spine.contents.map(item => item.id);
        const doc = new PDFDocument();
        const output = fs.createWriteStream(outputPath);
        doc.pipe(output);

        // Create top-level bookmark outline
        const outline = doc.outline;

        let isFirstImage = true;
        for (const chapterId of itemRefs) {
            try {
                const text = await getChapterRawAsync(epub, chapterId);
                const $ = cheerio.load(text);
                const chapterPath = epub.manifest[chapterId].href;
                
                let chapterBookmarkAdded = false;

                const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/g;
                const imagesInChapter = [];
                let match;

                while ((match = imgRegex.exec(text)) !== null) {
                    let imgSrc = match[1];
                    imgSrc = imgSrc.replace(/^\.\//, '');
                    imagesInChapter.push(imgSrc);
                }

                let currentIsFirst = isFirstImage;
                for (const imageFile of imagesInChapter) {
                    try {
                        const image = await getImageAsync(epub, imageFile);
                        const dimensions = sizeOf(image);

                        if (!currentIsFirst) doc.addPage();

                        // Fit image to page while maintaining aspect ratio
                        const pageWidth = doc.page.width - 40; // 20px margin on each side
                        const pageHeight = doc.page.height - 40; // 20px margin on top and bottom
                        const scale = Math.min(pageWidth / dimensions.width, pageHeight / dimensions.height);
                        const width = dimensions.width * scale;
                        const height = dimensions.height * scale;
                        const x = (doc.page.width - width) / 2;
                        const y = (doc.page.height - height) / 2;

                        // Add image to PDF
                        doc.image(image, x, y, {
                            width: width,
                            height: height
                        });

                        // Add bookmark for the chapter after first image is processed
                        if (!chapterBookmarkAdded && tocMap.has(chapterPath)) {
                            outline.addItem(tocMap.get(chapterPath));
                            chapterBookmarkAdded = true;
                        }

                        currentIsFirst = false;
                    } catch (error) {
                        console.error(`Error processing image ${imageFile}:`, error);
                    }
                }

                if (imagesInChapter.length > 0) isFirstImage = false;
            } catch (error) {
                console.error(`Error processing chapter ${chapterId}:`, error);
            }
        }

        doc.end();
        console.log(`PDF created successfully: ${outputPath}`);
    } catch (error) {
        console.error('Error processing PDF:', error);
        process.exit(1);
    }
}

processPDF();
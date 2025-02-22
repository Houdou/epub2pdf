const fs = require('fs');
const path = require('path');
const EPub = require('epub');
const PDFDocument = require('pdfkit');
const sizeOf = require('image-size');
const util = require('util');
const cheerio = require('cheerio');

if (process.argv.length < 3) {
    console.error('Usage: node index.js <path-to-epub-file> [margin]');
    process.exit(1);
}

const margin = process.argv[3] ? parseInt(process.argv[3], 10) : 0;

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

        let size = [210, 297];

        // Find the size by checking the most common image size
        const imageSizes = new Map(); // Map to store size frequencies
        const sizePromises = [];
        const itemRefs = epub.spine.contents.map(item => item.id);

        // Collect all image files from all chapters
        for (const chapterId of itemRefs) {
            try {
                const text = await getChapterRawAsync(epub, chapterId);
                const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/g;
                let match;

                while ((match = imgRegex.exec(text)) !== null) {
                    let imgSrc = match[1].replace(/^\.\//, '');
                    sizePromises.push(
                        getImageAsync(epub, imgSrc).then(image => {
                            const dimensions = sizeOf(image);
                            const sizeKey = `${dimensions.width},${dimensions.height}`;
                            imageSizes.set(sizeKey, (imageSizes.get(sizeKey) || 0) + 1);
                        }).catch(error => {
                            console.error(`Error processing image size for ${imgSrc}:`, error);
                        })
                    );
                }
            } catch (error) {
                console.error(`Error analyzing chapter ${chapterId}:`, error);
            }
        }

        // Wait for all image size calculations
        await Promise.all(sizePromises);

        // Find the most common image size
        let maxCount = 0;
        let mostCommonSize = null;

        for (const [sizeKey, count] of imageSizes) {
            if (count > maxCount) {
                maxCount = count;
                mostCommonSize = sizeKey;
            }
        }

        // Set PDF size based on most common image size
        if (mostCommonSize) {
            const [width, height] = mostCommonSize.split(',').map(Number);
            size = [width, height];
        }

        const doc = new PDFDocument({
            size: size,
            autoFirstPage: true
        });
        const output = fs.createWriteStream(outputPath);
        doc.pipe(output);

        // Create top-level bookmark outline
        const outline = doc.outline;

        // Add cover page
        if (epub.metadata.cover) {
            try {
                const coverImage = await getImageAsync(epub, epub.metadata.cover);
                const dimensions = sizeOf(coverImage);

                // Fit cover to page while maintaining aspect ratio
                const pageWidth = doc.page.width - (margin * 2);
                const pageHeight = doc.page.height - (margin * 2);
                const scale = Math.min(pageWidth / dimensions.width, pageHeight / dimensions.height);
                const width = dimensions.width * scale;
                const height = dimensions.height * scale;
                const x = (doc.page.width - width) / 2;
                const y = (doc.page.height - height) / 2;

                // Add cover image to PDF
                doc.image(coverImage, x, y, {
                    width: width,
                    height: height
                });
            } catch (error) {
                console.error('Error processing cover image:', error);
            }
        }

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

                for (const imageFile of imagesInChapter) {
                    try {
                        const image = await getImageAsync(epub, imageFile);
                        const dimensions = sizeOf(image);

                        doc.addPage();

                        // Fit image to page while maintaining aspect ratio
                        const pageWidth = doc.page.width - (margin * 2); // Apply margin on both sides
                        const pageHeight = doc.page.height - (margin * 2); // Apply margin on top and bottom
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
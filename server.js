"use strict";

"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const vision = require("@google-cloud/vision");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const speech = require("@google-cloud/speech");

const app = express();

const PORT =
    Number(
        process.env.PORT
    ) || 3000;
/* =========================================================
   DIRECTORIES
========================================================= */

const HOME_DIR =
    process.env.HOME ||
    process.cwd();


const REVIEWWISE_DIR =
    path.join(
        HOME_DIR,
        "storage",
        "shared",
        "ReviewWise"
    );


const uploadsDir =
    path.join(
        REVIEWWISE_DIR,
        "uploads"
    );


fs.mkdirSync(
    uploadsDir,
    {
        recursive: true
    }
);


console.log(
    "================================="
);

console.log(
    "ReviewWise directory:"
);

console.log(
    REVIEWWISE_DIR
);

console.log(
    "Uploads directory:"
);

console.log(
    uploadsDir
);

console.log(
    "================================="
);


/* =========================================================
   GOOGLE CLOUD VISION
========================================================= */

let visionClient =
    null;


try {

    visionClient =
        new vision.ImageAnnotatorClient();

    console.log(
        "Google Cloud Vision client initialized."
    );

} catch (error) {

    console.error(
        "Google Vision initialization failed:"
    );

    console.error(
        error.message
    );
}


/* =========================================================
   EXPRESS
========================================================= */

app.use(
    cors()
);


app.use(
    express.json({
        limit: "10mb"
    })
);


app.use(
    express.urlencoded({
        extended: true,
        limit: "10mb"
    })
);


/* =========================================================
   FFMPEG
========================================================= */

const ffmpegPath =
    "/data/data/com.termux/files/usr/bin/ffmpeg";


if (
    fs.existsSync(
        ffmpegPath
    )
) {

    ffmpeg.setFfmpegPath(
        ffmpegPath
    );

    console.log(
        "FFmpeg found:",
        ffmpegPath
    );

} else {

    console.log(
        "WARNING: FFmpeg not found."
    );

    console.log(
        "Install it using:"
    );

    console.log(
        "pkg install ffmpeg"
    );
}


/* =========================================================
   MULTER
========================================================= */

const imageUpload =
    multer({

        dest:
            uploadsDir,

        limits: {

            fileSize:
                10 *
                1024 *
                1024
        },

        fileFilter:
            (
                req,
                file,
                cb
            ) => {

                if (
                    file.mimetype &&
                    file.mimetype.startsWith(
                        "image/"
                    )
                ) {

                    cb(
                        null,
                        true
                    );

                } else {

                    cb(
                        new Error(
                            "Please upload an image file."
                        )
                    );
                }
            }
    });


const videoUpload =
    multer({

        dest:
            uploadsDir,

        limits: {

            fileSize:
                60 *
                1024 *
                1024
        },

        fileFilter:
            (
                req,
                file,
                cb
            ) => {

                if (
                    file.mimetype &&
                    file.mimetype.startsWith(
                        "video/"
                    )
                ) {

                    cb(
                        null,
                        true
                    );

                } else {

                    cb(
                        new Error(
                            "Please upload a video file."
                        )
                    );
                }
            }
    });


const allowedFileExtensions =
    [".pdf", ".docx", ".txt"];

const allowedFileMimeTypes =
    [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain"
    ];

const fileUpload =
    multer({

        dest:
            uploadsDir,

        limits: {

            fileSize:
                20 *
                1024 *
                1024
        },

        fileFilter:
            (
                req,
                file,
                cb
            ) => {

                const ext =
                    path.extname(
                        file.originalname || ""
                    ).toLowerCase();

                const mimeOk =
                    allowedFileMimeTypes.includes(
                        file.mimetype
                    ) ||
                    file.mimetype ===
                        "application/octet-stream";

                if (
                    allowedFileExtensions.includes(ext) &&
                    mimeOk
                ) {

                    cb(null, true);

                } else {

                    cb(
                        new Error(
                            "Unsupported file type. Use PDF, DOCX, or TXT."
                        )
                    );
                }
            }
    });


/* =========================================================
   SUSPICIOUS WORD CATEGORIES
========================================================= */

const wordCategories = {

    clickbait: [

        "shocking",
        "breaking",
        "viral",
        "click here",
        "share this"

    ],

    misleading: [

        "guaranteed",
        "101%",
        "unbelievable",
        "secret"

    ]
};


/* =========================================================
   HELPERS
========================================================= */

function escapeRegex(
    str
) {

    return String(
        str
    ).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
    );
}


function safeDelete(
    filePath
) {

    if (
        !filePath
    ) {
        return;
    }

    fs.unlink(
        filePath,
        () => {}
    );
}


function cleanText(
    text
) {

    return String(
        text ||
        ""
    )

        .normalize(
            "NFKC"
        )

        .replace(
            /\r/g,
            ""
        )

        .replace(
            /[ \t]+/g,
            " "
        )

        .replace(
            /\n{3,}/g,
            "\n\n"
        )

        .trim();
}


function normalizeText(
    text
) {

    return String(
        text ||
        ""
    )

        .normalize(
            "NFKC"
        )

        .toLowerCase()

        .replace(
            /\s+/g,
            " "
        )

        .trim();
}


/* =========================================================
   PHRASE MATCHING
========================================================= */

function findPhraseMatches(
    text,
    phrases
) {

    const normalized =
        normalizeText(
            text
        );


    const matches = [];


    phrases.forEach(
        phrase => {

            const target =
                normalizeText(
                    phrase
                );


            if (
                !target
            ) {
                return;
            }


            const regex =
                new RegExp(
                    `(^|[^a-z0-9])${escapeRegex(target)}([^a-z0-9]|$)`,
                    "i"
                );


            if (
                regex.test(
                    normalized
                )
            ) {

                matches.push(
                    phrase
                );
            }
        }
    );


    return matches;
}


/* =========================================================
   TEXT ANALYZER
========================================================= */

function analyzeText(
    text
) {

    text =
        String(
            text ||
            ""
        );


    const explanation = [];


    let credibility =
        100;


    /* =====================================================
       SUSPICIOUS PHRASES
    ====================================================== */

    const clickbaitMatches =
        findPhraseMatches(
            text,
            wordCategories.clickbait
        );


    const misleadingMatches =
        findPhraseMatches(
            text,
            wordCategories.misleading
        );


    const suspiciousMatches =
        [
            ...clickbaitMatches,
            ...misleadingMatches
        ];


    /* =====================================================
       CLICKBAIT
    ====================================================== */

    clickbaitMatches.forEach(
        word => {

            credibility -=
                5;

            explanation.push({

                type:
                    "clickbait",

                text:
                    `"${word}" uses attention-grabbing language that may create urgency or emotional reaction.`

            });
        }
    );


    /* =====================================================
       MISLEADING / ABSOLUTE CLAIMS
    ====================================================== */

    misleadingMatches.forEach(
        word => {

            credibility -=
                5;

            explanation.push({

                type:
                    "misleading",

                text:
                    `"${word}" may indicate an absolute or exaggerated claim that should be supported by evidence.`

            });
        }
    );


    /* =====================================================
       EXCLAMATION MARKS
    ====================================================== */

    const exclamationCount =
        (
            text.match(
                /!/g
            ) || []
        ).length;


    if (
        exclamationCount >=
        3
    ) {

        credibility -=
            Math.min(
                8,
                Math.floor(
                    exclamationCount /
                    2
                )
            );


        explanation.push({

            type:
                "punctuation",

            text:
                `The content contains ${exclamationCount} exclamation marks, which can make the message appear unusually urgent or emotional.`

        });
    }


    /* =====================================================
       ALL CAPS
    ====================================================== */

    const capsWords =
        (
            text.match(
                /\b[A-Z]{3,}\b/g
            ) || []
        );


    if (
        capsWords.length >=
        3
    ) {

        credibility -=
            Math.min(
                8,
                Math.floor(
                    capsWords.length /
                    2
                )
            );


        explanation.push({

            type:
                "capitalization",

            text:
                `The content uses ${capsWords.length} ALL CAPS words, which can emphasize or intensify the message.`

        });
    }


    /* =====================================================
       EMOTIONAL LANGUAGE
    ====================================================== */

    const emotionalTerms = [

        "urgent",
        "must see",
        "act now",
        "don't miss",
        "hurry",
        "everyone needs to know",
        "share immediately",
        "right now"

    ];


    const emotionalMatches =
        findPhraseMatches(
            text,
            emotionalTerms
        );


    if (
        emotionalMatches.length
        > 0
    ) {

        credibility -=
            Math.min(
                8,
                emotionalMatches.length *
                2
            );


        explanation.push({

            type:
                "emotional",

            text:
                `The content uses emotionally urgent language such as ${emotionalMatches.join(", ")}.`

        });
    }


    /* =====================================================
       CLAMP SCORE
    ====================================================== */

    credibility =
        Math.max(
            0,
            Math.min(
                100,
                credibility
            )
        );


    /* =====================================================
       SCORE CATEGORY
    ====================================================== */

    let status =
        "HIGH CREDIBILITY";


    if (
        credibility >=
        50 &&
        credibility <=
        79
    ) {

        status =
            "MODERATE CREDIBILITY";
    }


    if (
        credibility <
        50
    ) {

        status =
            "LOW CREDIBILITY";
    }


    /* =====================================================
       RISK
    ====================================================== */

    const suspicious =
        100 -
        credibility;


    /* =====================================================
       BREAKDOWN
    ====================================================== */

    const clickbait =
        clickbaitMatches.length;


    const misleading =
        misleadingMatches.length;


    const punctuation =
        exclamationCount;


    const capitalization =
        capsWords.length;


    const emotional =
        emotionalMatches.length;


    /* =====================================================
       DEFAULT EXPLANATION
    ====================================================== */

    if (
        explanation.length ===
        0
    ) {

        explanation.push({

            type:
                "none",

            text:
                "No major suspicious language patterns were detected. This does not guarantee that the information is factually correct."

        });
    }


    return {

        credibility,

        suspicious,

        suspiciousCount:
            suspiciousMatches.length,

        clickbait,

        misleading,

        punctuation,

        capitalization,

        emotional,

        status,

        explanation

    };
}


/* =========================================================
   HIGHLIGHTED WORDS
========================================================= */

function getHighlightedWordsFromText(
    text
) {

    const matches = [];


    Object.entries(
        wordCategories
    ).forEach(
        (
            [
                category,
                words
            ]
        ) => {

            words.forEach(
                word => {

                    const regex =
                        new RegExp(
                            `(?<![A-Za-z0-9])${escapeRegex(word)}(?![A-Za-z0-9])`,
                            "gi"
                        );


                    let match;


                    while (
                        (
                            match =
                                regex.exec(
                                    text
                                )
                        ) !== null
                    ) {

                        matches.push({

                            text:
                                match[0],

                            category

                        });
                    }
                }
            );
        }
    );


    /*
     * Remove duplicate positions.
     */

    const seen =
        new Set();


    return matches.filter(
        item => {

            const key =
                `${item.text.toLowerCase()}_${item.category}`;


            if (
                seen.has(
                    key
                )
            ) {

                return false;
            }


            seen.add(
                key
            );


            return true;
        }
    );
}


/* =========================================================
   GOOGLE VISION CATEGORY
========================================================= */

function categorizeWord(
    word
) {

    const normalized =
        String(
            word ||
            ""
        )
            .toLowerCase()
            .replace(
                /[^a-z0-9%]/g,
                ""
            );


    if (
        !normalized
    ) {

        return null;
    }


    for (
        const [
            category,
            words
        ]
        of Object.entries(
            wordCategories
        )
    ) {

        for (
            const suspiciousWord
            of words
        ) {

            const target =
                suspiciousWord
                    .toLowerCase()
                    .replace(
                        /[^a-z0-9%]/g,
                        ""
                    );


            if (
                normalized ===
                    target ||
                normalized.includes(
                    target
                ) ||
                target.includes(
                    normalized
                )
            ) {

                return category;
            }
        }
    }


    return null;
}


/* =========================================================
   OCR QUALITY SCORING (SERVER)
   =========================================================
   Mirrors the client-side scorer: blends engine confidence
   with text-shape heuristics so "confidence" reflects how
   trustworthy the text actually looks, not just whatever
   number the OCR engine reports.
========================================================= */

function computeServerOcrQuality(
    text,
    engineConfidence
) {

    const clean =
        String(text || "").trim();

    if (!clean) {

        return {
            score: 0,
            label: "Poor"
        };
    }

    const letters =
        (clean.match(/[A-Za-z]/g) || []).length;

    const digits =
        (clean.match(/[0-9]/g) || []).length;

    const total =
        clean.length;

    const alphaRatio =
        total > 0 ? (letters + digits) / total : 0;

    const weirdSymbols =
        (clean.match(/[^\w\s.,!?;:'"()\-%$@#&/]/g) || []).length;

    const weirdRatio =
        total > 0 ? weirdSymbols / total : 0;

    const words =
        clean.split(/\s+/).filter(Boolean);

    const dictionaryLikeWords =
        words.filter(
            w => /^[A-Za-z][A-Za-z'-]{1,}$/.test(w)
        ).length;

    const wordValidityRatio =
        words.length > 0
            ? dictionaryLikeWords / words.length
            : 0;

    const confidence =
        Number.isFinite(engineConfidence)
            ? Math.max(0, Math.min(100, engineConfidence))
            : 55;

    let score =
        (confidence * 0.45) +
        (alphaRatio * 100 * 0.25) +
        (wordValidityRatio * 100 * 0.2) +
        (Math.max(0, 1 - weirdRatio * 4) * 100 * 0.1);

    if (total < 8) {
        score -= 15;
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    let label = "Poor";

    if (score >= 85) label = "Excellent";
    else if (score >= 70) label = "Good";
    else if (score >= 45) label = "Fair";

    return { score, label };
}


/* =========================================================
   RUN VISION ON A SINGLE IMAGE FILE
========================================================= */

async function runVisionOnFile(
    filePath
) {

    const [result] =
        await visionClient.documentTextDetection(filePath);

    if (result.error && result.error.message) {
        throw new Error(result.error.message);
    }

    const fullText =
        result.fullTextAnnotation;

    const rawText =
        fullText?.text || "";

    const highlightedWords = [];

    let totalConfidence = 0;
    let confidenceCount = 0;

    const pages = fullText?.pages || [];

    pages.forEach(
        page => {

            if (typeof page.confidence === "number") {
                totalConfidence += page.confidence;
                confidenceCount++;
            }

            (page.blocks || []).forEach(
                block => {

                    (block.paragraphs || []).forEach(
                        paragraph => {

                            (paragraph.words || []).forEach(
                                word => {

                                    let wordText = "";

                                    (word.symbols || []).forEach(
                                        symbol => {
                                            wordText += symbol.text || "";
                                        }
                                    );

                                    wordText = wordText.trim();

                                    if (!wordText) return;

                                    if (typeof word.confidence === "number") {
                                        totalConfidence += word.confidence;
                                        confidenceCount++;
                                    }

                                    const category =
                                        categorizeWord(wordText);

                                    if (!category) return;

                                    const vertices =
                                        word.boundingBox?.vertices || [];

                                    const xs =
                                        vertices.map(v => Number(v.x || 0));

                                    const ys =
                                        vertices.map(v => Number(v.y || 0));

                                    if (xs.length === 0 || ys.length === 0) {
                                        return;
                                    }

                                    highlightedWords.push({

                                        text: wordText,
                                        category,

                                        confidence:
                                            Math.round(
                                                Number(word.confidence || 0) * 100
                                            ),

                                        bbox: {
                                            x0: Math.min(...xs),
                                            y0: Math.min(...ys),
                                            x1: Math.max(...xs),
                                            y1: Math.max(...ys)
                                        }
                                    });
                                }
                            );
                        }
                    );
                }
            );
        }
    );

    const ocrConfidence =
        confidenceCount > 0
            ? Math.round((totalConfidence / confidenceCount) * 100)
            : 0;

    return { rawText, highlightedWords, ocrConfidence };
}


/* =========================================================
   GOOGLE VISION OCR — MULTI-PASS
   =========================================================
   Builds several preprocessing variants of the uploaded
   image (never touching the original file), runs OCR on
   each, and keeps the variant with the best computed OCR
   quality score instead of blindly using the first pass.
========================================================= */

/* =========================================================
   GOOGLE VISION OCR
   TERMUX / ANDROID SAFE VERSION
   =========================================================
   This version intentionally does NOT use Sharp.
   Google Vision processes the original uploaded image
   directly, avoiding native libvips/sharp problems on
   Android ARM64 / Termux.
========================================================= */

async function performGoogleOCR(
    imagePath
) {

    if (!visionClient) {

        throw new Error(
            "Google Cloud Vision is not initialized. Check your Google credentials."
        );
    }

    if (
        !imagePath ||
        !fs.existsSync(imagePath)
    ) {

        throw new Error(
            "The uploaded image could not be found."
        );
    }

    try {

        console.log(
            "Running Google Vision OCR..."
        );

        const ocrResult =
            await runVisionOnFile(
                imagePath
            );

        const cleanedText =
            cleanText(
                ocrResult.rawText
            );

        if (!cleanedText) {

            throw new Error(
                "Unable to read text from this image. Try using a clearer or brighter photo."
            );
        }

        const quality =
            computeServerOcrQuality(
                cleanedText,
                ocrResult.ocrConfidence
            );

        console.log(
            `OCR confidence: ${ocrResult.ocrConfidence}%`
        );

        console.log(
            `OCR quality: ${quality.score}% (${quality.label})`
        );

        return {

            text:
                cleanedText,

            rawText:
                ocrResult.rawText,

            highlightedWords:
                ocrResult.highlightedWords,

            ocrConfidence:
                ocrResult.ocrConfidence,

            ocrQuality:
                quality.score,

            ocrQualityLabel:
                quality.label

        };

    } catch (
        error
    ) {

        console.error(
            "Google Vision OCR failed:",
            error.message
        );

        throw new Error(
            error.message ||
            "Unable to process the image."
        );
    }
}

app.post(
    "/analyze",
    (
        req,
        res
    ) => {

        try {

            const text =
                cleanText(
                    req.body?.text ||
                    ""
                );


            if (
                !text
            ) {

                return res.status(
                    400
                ).json({

                    error:
                        "Please provide text to analyze."

                });
            }


            const analysis =
                analyzeText(
                    text
                );


            const highlightedWords =
                getHighlightedWordsFromText(
                    text
                );


            res.json({

                ...analysis,

                text,

                highlightedWords,

                contentType:
                    "text"

            });


        } catch (
            error
        ) {

            console.error(
                "TEXT API ERROR:",
                error
            );


            res.status(
                500
            ).json({

                error:
                    "Unable to analyze text."

            });
        }
    }
);


/* =========================================================
   IMAGE API
========================================================= */

app.post(
    "/analyze-image",

    imageUpload.single(
        "photo"
    ),

    async (
        req,
        res
    ) => {

        if (
            !req.file
        ) {

            return res.status(
                400
            ).json({

                error:
                    "No image uploaded."

            });
        }


        try {

            const ocr =
                await performGoogleOCR(
                    req.file.path
                );


            const extractedText =
                ocr.text;


            if (
                !extractedText
            ) {

                throw new Error(
                    "Unable to read text from this image. Try using a clearer or brighter photo."
                );
            }


            const analysis =
                analyzeText(
                    extractedText
                );


            /*
             * OCR REQUIREMENT (#7):
             * Don't let a low-confidence OCR read produce a
             * falsely confident credibility verdict — dampen
             * the score toward neutral and flag it clearly
             * when OCR quality is low, instead of applying
             * suspicious-word penalties at full strength.
             */

            let credibility =
                analysis.credibility;

            let ocrLowConfidence =
                false;

            if (
                Number.isFinite(ocr.ocrQuality) &&
                ocr.ocrQuality < 60
            ) {

                const weight =
                    Math.max(0.35, ocr.ocrQuality / 60);

                credibility =
                    Math.round(
                        analysis.credibility * weight +
                        75 * (1 - weight)
                    );

                ocrLowConfidence = true;
            }


            const textHighlights =
                getHighlightedWordsFromText(
                    extractedText
                );


            const merged =
                [
                    ...ocr.highlightedWords
                ];


            textHighlights.forEach(
                item => {

                    const exists =
                        merged.some(
                            existing =>
                                existing.text
                                    .toLowerCase() ===
                                item.text
                                    .toLowerCase()
                        );


                    if (
                        !exists
                    ) {

                        merged.push(
                            item
                        );
                    }
                }
            );


            safeDelete(
                req.file.path
            );


            res.json({

                ...analysis,

                credibility,

                suspicious:
                    100 - credibility,

                text:
                    extractedText,

                rawText:
                    ocr.rawText,

                highlightedWords:
                    merged,

                ocrConfidence:
                    ocr.ocrConfidence,

                ocrQuality:
                    ocr.ocrQuality,

                ocrQualityLabel:
                    ocr.ocrQualityLabel,

                ocrLowConfidence,

                contentType:
                    "image"

            });


        } catch (
            error
        ) {

            console.error(
                "IMAGE OCR ERROR:",
                error
            );


            safeDelete(
                req.file.path
            );


            res.status(
                500
            ).json({

                error:
                    error.message ||
                    "Unable to process the image."

            });
        }
    }
);


/* =========================================================
   VIDEO FRAME EXTRACTION
========================================================= */

function extractVideoFrames(
    videoPath,
    framesDir
) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            ffmpeg(
                videoPath
            )

                .on(
                    "end",
                    resolve
                )

                .on(
                    "error",
                    reject
                )

                .screenshots({

                    count:
                        6,

                    folder:
                        framesDir,

                    filename:
                        "frame-%i.png"

                });
        }
    );
}


/* =========================================================
   NORMALIZE VIDEO TEXT
========================================================= */

function normalizeVideoLine(
    line
) {

    return normalizeText(
        line
    )
        .replace(
            /[^a-z0-9%!?.,:'"-]+/g,
            " "
        )
        .trim();
}


/* =========================================================
   VIDEO API
========================================================= */

app.post(
    "/analyze-video",

    videoUpload.single(
        "video"
    ),

    async (
        req,
        res
    ) => {

        if (
            !req.file
        ) {

            return res.status(
                400
            ).json({

                error:
                    "No video uploaded."

            });
        }


        const framesDir =
            path.join(
                uploadsDir,
                `frames_${Date.now()}`
            );


        try {

            if (
                !fs.existsSync(
                    ffmpegPath
                )
            ) {

                throw new Error(
                    "FFmpeg is not installed. Run: pkg install ffmpeg"
                );
            }


            fs.mkdirSync(
                framesDir,
                {
                    recursive:
                        true
                }
            );


            /*
             * Extract only 6 frames.
             * This avoids processing every frame.
             */

            await extractVideoFrames(
                req.file.path,
                framesDir
            );


            const frameFiles =
                fs.readdirSync(
                    framesDir
                )

                    .filter(
                        file =>
                            /\.(png|jpg|jpeg)$/i
                                .test(
                                    file
                                )
                    )

                    .sort();


            if (
                frameFiles.length ===
                0
            ) {

                throw new Error(
                    "No readable video frames were extracted."
                );
            }


            let lines = [];

            let confidenceTotal =
                0;

            let confidenceCount =
                0;


            /* =================================================
               OCR EACH SELECTED FRAME
            ================================================== */

            for (
                let i = 0;
                i < frameFiles.length;
                i++
            ) {

                const frame =
                    frameFiles[i];


                try {

                    const ocr =
                        await performGoogleOCR(
                            path.join(
                                framesDir,
                                frame
                            )
                        );


                    if (
                        ocr.text
                    ) {

                        const frameLines =
                            ocr.text
                                .split(
                                    /\n+/
                                )
                                .map(
                                    normalizeVideoLine
                                )
                                .filter(
                                    Boolean
                                );


                        lines.push(
                            ...frameLines
                        );
                    }


                    if (
                        Number.isFinite(
                            ocr.ocrConfidence
                        )
                    ) {

                        confidenceTotal +=
                            ocr.ocrConfidence;

                        confidenceCount++;
                    }


                } catch (
                    error
                ) {

                    console.error(
                        `Video frame ${i + 1} OCR failed:`,
                        error.message
                    );
                }
            }


            /* =================================================
               REMOVE DUPLICATE OCR TEXT
            ================================================== */

            const uniqueLines =
                [];


            const seen =
                new Set();


            lines.forEach(
                line => {

                    const key =
                        normalizeText(
                            line
                        );


                    if (
                        !key ||
                        key.length <
                            2
                    ) {

                        return;
                    }


                    /*
                     * Remove exact duplicates.
                     */

                    if (
                        seen.has(
                            key
                        )
                    ) {

                        return;
                    }


                    /*
                     * Also ignore near-duplicates when one
                     * OCR line is contained in another.
                     */

                    const nearDuplicate =
                        uniqueLines.some(
                            existing => {

                                return (
                                    existing ===
                                        key ||
                                    existing.includes(
                                        key
                                    ) ||
                                    key.includes(
                                        existing
                                    )
                                );
                            }
                        );


                    if (
                        nearDuplicate
                    ) {

                        return;
                    }


                    seen.add(
                        key
                    );

                    uniqueLines.push(
                        key
                    );
                }
            );


            const combinedText =
                cleanText(
                    uniqueLines.join(
                        "\n"
                    )
                );


            if (
                !combinedText
            ) {

                throw new Error(
                    "No readable text was found in the selected video frames."
                );
            }


            /* =================================================
               ANALYZE
            ================================================== */

            const analysis =
                analyzeText(
                    combinedText
                );


            const highlightedWords =
                getHighlightedWordsFromText(
                    combinedText
                );


            const averageConfidence =
                confidenceCount > 0
                    ? Math.round(
                        confidenceTotal /
                        confidenceCount
                    )
                    : 0;


            /* =================================================
               RESPONSE
            ================================================== */

            res.json({

                ...analysis,

                text:
                    combinedText,

                highlightedWords,

                ocrConfidence:
                    averageConfidence,

                framesScanned:
                    frameFiles.length,

                contentType:
                    "video"

            });


        } catch (
            error
        ) {

            console.error(
                "VIDEO OCR ERROR:",
                error
            );


            res.status(
                500
            ).json({

                error:
                    error.message ||
                    "Unable to process the video."

            });


        } finally {

            safeDelete(
                req.file.path
            );


            fs.rm(
                framesDir,
                {
                    recursive:
                        true,

                    force:
                        true
                },
                () => {}
            );
        }
    }
);


/* =========================================================
   FILE API
========================================================= */

app.post(
    "/analyze-file",

    fileUpload.single(
        "file"
    ),

    async (
        req,
        res
    ) => {

        if (
            !req.file
        ) {

            return res.status(
                400
            ).json({

                error:
                    "No file uploaded."

            });
        }


        const ext =
            path.extname(
                req.file.originalname
            ).toLowerCase();


        try {

            let extractedText =
                "";


            let ocrConfidence =
                null;


            /* =================================================
               TXT
            ================================================== */

            if (
                ext ===
                ".txt"
            ) {

                extractedText =
                    fs.readFileSync(
                        req.file.path,
                        "utf8"
                    );
            }


            /* =================================================
               PDF
            ================================================== */

            else if (
                ext ===
                ".pdf"
            ) {

                const buffer =
                    fs.readFileSync(
                        req.file.path
                    );


                const data =
                    await pdfParse(
                        buffer
                    );


                extractedText =
                    data.text ||
                    "";
            }


            /* =================================================
               DOCX
            ================================================== */

            else if (
                ext ===
                ".docx"
            ) {

                const result =
                    await mammoth.extractRawText({

                        path:
                            req.file.path

                    });


                extractedText =
                    result.value ||
                    "";
            }


            /* =================================================
               UNSUPPORTED
            ================================================== */

            else {

                throw new Error(
                    "Unsupported file type. Use TXT, PDF, or DOCX."
                );
            }


            extractedText =
                cleanText(
                    extractedText
                );


            if (
                !extractedText
            ) {

                throw new Error(
                    "No readable text was found in this file."
                );
            }


            const analysis =
                analyzeText(
                    extractedText
                );


            const highlightedWords =
                getHighlightedWordsFromText(
                    extractedText
                );


            res.json({

                ...analysis,

                text:
                    extractedText,

                highlightedWords,

                contentType:
                    "file",

                ...(ocrConfidence !== null
                    ? {
                        ocrConfidence
                    }
                    : {})

            });


        } catch (
            error
        ) {

            console.error(
                "FILE ANALYSIS ERROR:",
                error
            );


            res.status(
                500
            ).json({

                error:
                    error.message ||
                    "Unable to read this file."

            });


        } finally {

            safeDelete(
                req.file.path
            );
        }
    }
);


/* =========================================================
   API 404
========================================================= */

app.use(
    (
        req,
        res,
        next
    ) => {

        if (
            req.path.startsWith(
                "/analyze"
            )
        ) {

            return res.status(
                404
            ).json({

                error:
                    `API endpoint not found: ${req.method} ${req.path}`

            });
        }


        next();
    }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (
        err,
        req,
        res,
        next
    ) => {

        console.error(
            "SERVER ERROR:",
            err
        );


        if (
            req.file?.path
        ) {

            safeDelete(
                req.file.path
            );
        }


        let status =
            500;


        if (
            err.code ===
            "LIMIT_FILE_SIZE"
        ) {

            status =
                413;
        }


        res.status(
            status
        ).json({

            error:
                err.message ||
                "Server error."

        });
    }
);


/* =========================================================
   SERVE WEBSITE
========================================================= */

app.use(
    express.static(
        __dirname
    )
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "================================="
        );

        console.log(
            "ReviewWise server running!"
        );

        console.log(
            `http://localhost:${PORT}`
        );

        console.log(
            "================================="
        );
    }
);

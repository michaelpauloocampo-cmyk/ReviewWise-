"use strict";

/* =========================================================
   REVIEWWISE AI CREDIBILITY CHECKER
   FULL BACKEND SERVER
   Render / Localhost compatible
========================================================= */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

const vision = require("@google-cloud/vision");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");


/* =========================================================
   APP CONFIGURATION
========================================================= */

const app = express();

const PORT =
    Number(process.env.PORT) || 3000;

const BASE_DIR =
    __dirname;

const uploadsDir =
    path.join(
        BASE_DIR,
        "uploads"
    );


/* =========================================================
   CREATE UPLOAD DIRECTORY
========================================================= */

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
    "ReviewWise server starting..."
);

console.log(
    "Base directory:",
    BASE_DIR
);

console.log(
    "Uploads directory:",
    uploadsDir
);

console.log(
    "================================="
);


/* =========================================================
   GOOGLE CLOUD VISION
========================================================= */

let visionClient = null;

try {

    /*
       Option 1:
       GOOGLE_CREDENTIALS_JSON

       Put your complete Google service-account JSON
       inside the Render environment variable.
    */

    if (
        process.env.GOOGLE_CREDENTIALS_JSON
    ) {

        const credentials =
            JSON.parse(
                process.env.GOOGLE_CREDENTIALS_JSON
            );


        visionClient =
            new vision.ImageAnnotatorClient({

                credentials: {

                    client_email:
                        credentials.client_email,

                    private_key:
                        String(
                            credentials.private_key ||
                            ""
                        ).replace(
                            /\\n/g,
                            "\n"
                        )
                },

                projectId:
                    credentials.project_id

            });


        console.log(
            "Google Cloud Vision client initialized using GOOGLE_CREDENTIALS_JSON."
        );

    }

    /*
       Option 2:
       GOOGLE_APPLICATION_CREDENTIALS

       Google Cloud can automatically load the
       credentials file from this environment variable.
    */

    else {

        visionClient =
            new vision.ImageAnnotatorClient();


        console.log(
            "Google Cloud Vision client initialized using default credentials."
        );
    }

} catch (
    error
) {

    console.error(
        "Google Vision initialization failed:"
    );

    console.error(
        error.message
    );

    console.warn(
        "OCR features will not work until Google Cloud Vision credentials are configured."
    );
}


/* =========================================================
   EXPRESS MIDDLEWARE
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

if (
    ffmpegPath
) {

    ffmpeg.setFfmpegPath(
        ffmpegPath
    );


    console.log(
        "FFmpeg found:"
    );

    console.log(
        ffmpegPath
    );

} else {

    console.warn(
        "WARNING: ffmpeg-static did not provide an FFmpeg binary."
    );
}


/* =========================================================
   MULTER - IMAGE UPLOAD
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


/* =========================================================
   MULTER - VIDEO UPLOAD
========================================================= */

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


/* =========================================================
   FILE UPLOAD
========================================================= */

const allowedFileExtensions =
    [
        ".pdf",
        ".docx",
        ".txt"
    ];


const allowedFileMimeTypes =
    [
        "application/pdf",

        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

        "text/plain",

        "application/octet-stream"
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
                        file.originalname ||
                        ""
                    ).toLowerCase();


                const mimeOk =
                    allowedFileMimeTypes.includes(
                        file.mimetype
                    );


                if (
                    allowedFileExtensions.includes(
                        ext
                    ) &&
                    mimeOk
                ) {

                    cb(
                        null,
                        true
                    );

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
   HELPER - ESCAPE REGEX
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


/* =========================================================
   HELPER - DELETE FILE
========================================================= */

function safeDelete(
    filePath
) {

    if (
        !filePath
    ) {

        return;
    }


    try {

        if (
            fs.existsSync(
                filePath
            )
        ) {

            fs.unlinkSync(
                filePath
            );

        }

    } catch (
        error
    ) {

        console.warn(
            "Could not delete file:",
            filePath
        );
    }
}


/* =========================================================
   CLEAN TEXT
========================================================= */

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


/* =========================================================
   NORMALIZE TEXT
========================================================= */

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
   FIND PHRASE MATCHES
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
       -5 EACH
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
       MISLEADING
       -5 EACH
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

        const penalty =
            Math.min(
                8,
                Math.floor(
                    exclamationCount /
                    2
                )
            );


        credibility -=
            penalty;


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
        text.match(
            /\b[A-Z]{3,}\b/g
        ) || [];


    if (
        capsWords.length >=
        3
    ) {

        const penalty =
            Math.min(
                8,
                Math.floor(
                    capsWords.length /
                    2
                )
            );


        credibility -=
            penalty;


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
        emotionalMatches.length >
        0
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
                Math.round(
                    credibility
                )
            )
        );


    /* =====================================================
       STATUS
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

    } else if (
        credibility <
        50
    ) {

        status =
            "LOW CREDIBILITY";
    }


    const suspicious =
        100 -
        credibility;


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

        clickbait:
            clickbaitMatches.length,

        misleading:
            misleadingMatches.length,

        punctuation:
            exclamationCount,

        capitalization:
            capsWords.length,

        emotional:
            emotionalMatches.length,

        status,

        explanation

    };
}


/* =========================================================
   GET HIGHLIGHTED WORDS
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

                            category,

                            index:
                                match.index

                        });


                        if (
                            match[0] ===
                            ""
                        ) {

                            regex.lastIndex++;
                        }
                    }
                }
            );
        }
    );


    const seen =
        new Set();


    return matches.filter(
        item => {

            const key =
                `${item.index}_${item.text.toLowerCase()}_${item.category}`;


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
   CATEGORIZE OCR WORD
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
   OCR QUALITY
========================================================= */

function computeServerOcrQuality(
    text,
    engineConfidence
) {

    const clean =
        String(
            text ||
            ""
        ).trim();


    if (
        !clean
    ) {

        return {

            score:
                0,

            label:
                "Poor"

        };
    }


    const letters =
        (
            clean.match(
                /[A-Za-z]/g
            ) || []
        ).length;


    const digits =
        (
            clean.match(
                /[0-9]/g
            ) || []
        ).length;


    const total =
        clean.length;


    const alphaRatio =
        total > 0
            ? (
                letters +
                digits
            ) /
            total
            : 0;


    const weirdSymbols =
        (
            clean.match(
                /[^\w\s.,!?;:'"()\-%$@#&/]/g
            ) || []
        ).length;


    const weirdRatio =
        total > 0
            ? weirdSymbols /
              total
            : 0;


    const words =
        clean
            .split(
                /\s+/
            )
            .filter(
                Boolean
            );


    const dictionaryLikeWords =
        words.filter(
            word =>
                /^[A-Za-z][A-Za-z'-]{1,}$/
                    .test(
                        word
                    )
        ).length;


    const wordValidityRatio =
        words.length > 0
            ? dictionaryLikeWords /
              words.length
            : 0;


    const confidence =
        Number.isFinite(
            engineConfidence
        )

            ? Math.max(
                0,
                Math.min(
                    100,
                    engineConfidence
                )
            )

            : 55;


    let score =
        confidence *
        0.45 +

        alphaRatio *
        100 *
        0.25 +

        wordValidityRatio *
        100 *
        0.20 +

        Math.max(
            0,
            1 -
            weirdRatio *
            4
        ) *
        100 *
        0.10;


    if (
        total <
        8
    ) {

        score -=
            15;
    }


    score =
        Math.max(
            0,
            Math.min(
                100,
                Math.round(
                    score
                )
            )
        );


    let label =
        "Poor";


    if (
        score >=
        85
    ) {

        label =
            "Excellent";

    } else if (
        score >=
        70
    ) {

        label =
            "Good";

    } else if (
        score >=
        45
    ) {

        label =
            "Fair";
    }


    return {

        score,

        label

    };
}


/* =========================================================
   GOOGLE VISION OCR
========================================================= */

async function runVisionOnFile(
    filePath
) {

    if (
        !visionClient
    ) {

        throw new Error(
            "Google Cloud Vision is not configured. Add GOOGLE_CREDENTIALS_JSON to Render Environment Variables."
        );
    }


    const [
        result
    ] =
        await visionClient
            .documentTextDetection({

                image: {

                    source: {

                        filename:
                            filePath

                    }
                }
            });


    if (
        result.error &&
        result.error.message
    ) {

        throw new Error(
            result.error.message
        );
    }


    const fullText =
        result.fullTextAnnotation;


    const rawText =
        fullText?.text ||
        "";


    const highlightedWords = [];


    let totalConfidence =
        0;


    let confidenceCount =
        0;


    const pages =
        fullText?.pages ||
        [];


    pages.forEach(
        page => {

            if (
                typeof page.confidence ===
                "number"
            ) {

                totalConfidence +=
                    page.confidence;

                confidenceCount++;
            }


            (
                page.blocks ||
                []
            ).forEach(
                block => {

                    (
                        block.paragraphs ||
                        []
                    ).forEach(
                        paragraph => {

                            (
                                paragraph.words ||
                                []
                            ).forEach(
                                word => {

                                    let wordText =
                                        "";


                                    (
                                        word.symbols ||
                                        []
                                    ).forEach(
                                        symbol => {

                                            wordText +=
                                                symbol.text ||
                                                "";

                                        }
                                    );


                                    wordText =
                                        wordText.trim();


                                    if (
                                        !wordText
                                    ) {

                                        return;
                                    }


                                    if (
                                        typeof word.confidence ===
                                        "number"
                                    ) {

                                        totalConfidence +=
                                            word.confidence;

                                        confidenceCount++;
                                    }


                                    const category =
                                        categorizeWord(
                                            wordText
                                        );


                                    if (
                                        !category
                                    ) {

                                        return;
                                    }


                                    const vertices =
                                        word
                                            .boundingBox
                                            ?.vertices ||
                                        [];


                                    if (
                                        vertices.length ===
                                        0
                                    ) {

                                        return;
                                    }


                                    const xs =
                                        vertices.map(
                                            vertex =>
                                                Number(
                                                    vertex.x ||
                                                    0
                                                )
                                        );


                                    const ys =
                                        vertices.map(
                                            vertex =>
                                                Number(
                                                    vertex.y ||
                                                    0
                                                )
                                        );


                                    highlightedWords.push({

                                        text:
                                            wordText,

                                        category,

                                        confidence:
                                            Math.round(
                                                Number(
                                                    word.confidence ||
                                                    0
                                                ) *
                                                100
                                            ),

                                        bbox: {

                                            x0:
                                                Math.min(
                                                    ...xs
                                                ),

                                            y0:
                                                Math.min(
                                                    ...ys
                                                ),

                                            x1:
                                                Math.max(
                                                    ...xs
                                                ),

                                            y1:
                                                Math.max(
                                                    ...ys
                                                )

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
        confidenceCount >
        0

            ? Math.round(
                (
                    totalConfidence /
                    confidenceCount
                ) *
                100
            )

            : 0;


    return {

        rawText,

        highlightedWords,

        ocrConfidence

    };
}


/* =========================================================
   PERFORM GOOGLE OCR
========================================================= */

async function performGoogleOCR(
    imagePath
) {

    if (
        !imagePath ||
        !fs.existsSync(
            imagePath
        )
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


        if (
            !cleanedText
        ) {

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


/* =========================================================
   POST /analyze
   TEXT ANALYSIS
========================================================= */

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


            return res.json({

                ...analysis,

                text,

                highlightedWords:
                    getHighlightedWordsFromText(
                        text
                    ),

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


            return res.status(
                500
            ).json({

                error:
                    "Unable to analyze text."

            });
        }
    }
);


/* =========================================================
   POST /analyze-image
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


            const analysis =
                analyzeText(
                    extractedText
                );


            let credibility =
                analysis.credibility;


            let ocrLowConfidence =
                false;


            /*
               Prevent unreliable OCR from
               creating an extreme credibility score.
            */

            if (
                Number.isFinite(
                    ocr.ocrQuality
                ) &&
                ocr.ocrQuality <
                60
            ) {

                const weight =
                    Math.max(
                        0.35,
                        ocr.ocrQuality /
                        60
                    );


                credibility =
                    Math.round(

                        analysis.credibility *
                        weight +

                        75 *
                        (
                            1 -
                            weight
                        )

                    );


                ocrLowConfidence =
                    true;
            }


            const merged =
                [
                    ...ocr.highlightedWords
                ];


            const textHighlights =
                getHighlightedWordsFromText(
                    extractedText
                );


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


            return res.json({

                ...analysis,

                credibility,

                suspicious:
                    100 -
                    credibility,

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


            return res.status(
                500
            ).json({

                error:
                    error.message ||
                    "Unable to process the image."

            });

        } finally {

            safeDelete(
                req.file.path
            );
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
                    "start",
                    command => {

                        console.log(
                            "FFmpeg command started:"
                        );

                        console.log(
                            command
                        );
                    }
                )

                .on(
                    "end",
                    () => {

                        console.log(
                            "Video frames extracted."
                        );

                        resolve();
                    }
                )

                .on(
                    "error",
                    error => {

                        console.error(
                            "FFmpeg error:",
                            error.message
                        );

                        reject(
                            error
                        );
                    }
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
   NORMALIZE VIDEO LINE
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
   POST /analyze-video
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
                !ffmpegPath
            ) {

                throw new Error(
                    "FFmpeg is unavailable on this server."
                );
            }


            fs.mkdirSync(
                framesDir,
                {
                    recursive:
                        true
                }
            );


            await extractVideoFrames(
                req.file.path,
                framesDir
            );


            const frameFiles =
                fs

                    .readdirSync(
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


            const lines = [];


            let confidenceTotal =
                0;


            let confidenceCount =
                0;


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


                    if (
                        seen.has(
                            key
                        )
                    ) {

                        return;
                    }


                    const nearDuplicate =
                        uniqueLines.some(
                            existing =>
                                existing ===
                                key ||

                                existing.includes(
                                    key
                                ) ||

                                key.includes(
                                    existing
                                )
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


            const analysis =
                analyzeText(
                    combinedText
                );


            const averageConfidence =
                confidenceCount >
                0

                    ? Math.round(
                        confidenceTotal /
                        confidenceCount
                    )

                    : 0;


            return res.json({

                ...analysis,

                text:
                    combinedText,

                highlightedWords:
                    getHighlightedWordsFromText(
                        combinedText
                    ),

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


            return res.status(
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
   POST /analyze-file
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
                req.file.originalname ||
                ""
            ).toLowerCase();


        try {

            let extractedText =
                "";


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


            return res.json({

                ...analysis,

                text:
                    extractedText,

                highlightedWords:
                    getHighlightedWordsFromText(
                        extractedText
                    ),

                contentType:
                    "file"

            });

        } catch (
            error
        ) {

            console.error(
                "FILE ANALYSIS ERROR:",
                error
            );


            return res.status(
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
   HEALTH CHECK
========================================================= */

app.get(
    "/health",

    (
        req,
        res
    ) => {

        return res.json({

            status:
                "ok",

            service:
                "ReviewWise",

            timestamp:
                new Date().toISOString(),

            visionConfigured:
                Boolean(
                    visionClient
                ),

            ffmpegConfigured:
                Boolean(
                    ffmpegPath
                )

        });
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
            "SERVER ERROR:"
        );

        console.error(
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


        return res.status(
            status
        ).json({

            error:
                err.message ||
                "Server error."

        });
    }
);


/* =========================================================
   SERVE FRONTEND
========================================================= */

app.use(
    express.static(
        BASE_DIR
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
            `Port: ${PORT}`
        );

        console.log(
            `Local: http://localhost:${PORT}`
        );

        console.log(
            "================================="
        );
    }
);

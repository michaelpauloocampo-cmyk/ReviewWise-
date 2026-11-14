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


const vision = require("@google-cloud/vision");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");


/* =========================================================
   APP CONFIGURATION
========================================================= */

const app = express();

// Behind Render's proxy, use the real visitor IP for rate limiting.
app.set("trust proxy", 1);

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

// Security headers and configurable CORS. Set ALLOWED_ORIGINS as a
// comma-separated list in production; unset means same-origin requests only.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(value => value.trim()).filter(Boolean);

const allowVercelPreviewOrigins =
    String(process.env.ALLOW_VERCEL_ORIGINS || "true").toLowerCase() === "true";

function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (allowedOrigins.includes(origin)) return true;
    if (!allowVercelPreviewOrigins) return false;
    try {
        const hostname = new URL(origin).hostname;
        return hostname === "vercel.app" || hostname.endsWith(".vercel.app");
    } catch {
        return false;
    }
}

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(self)");
    next();
});

app.use(cors({
    origin(origin, callback) {
        // Allow non-browser/server-to-server calls and same-origin requests.
        if (isAllowedOrigin(origin)) return callback(null, true);
        // No CORS response headers for unlisted browser origins.
        return callback(null, false);
    }
}));

// Lightweight in-memory API rate limit. For multi-instance production hosting,
// replace this with a shared store (for example Redis).
const requestBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = Number(process.env.API_RATE_LIMIT) || 40;
setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [key, bucket] of requestBuckets) {
        if (bucket.start < cutoff) requestBuckets.delete(key);
    }
}, RATE_WINDOW_MS).unref();

app.use(/^\/analyze/, (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let bucket = requestBuckets.get(key);
    if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
        bucket = { start: now, count: 0 };
    }
    bucket.count += 1;
    requestBuckets.set(key, bucket);
    if (bucket.count > RATE_LIMIT) {
        return res.status(429).json({ error: "Too many analysis requests. Please wait a minute and try again." });
    }
    next();
});


app.get("/capabilities", (req, res) => {
    res.json({
        textPatternAnalysis: true,
        imageOcr: Boolean(visionClient),
        scannedPdfOcr: Boolean(visionClient),
        pdfAndDocxExtraction: true,
        liveFactChecking: false,
        accounts: false,
        note: "The language-risk analysis identifies wording patterns; it does not establish whether a claim is true or false."
    });
});


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
        "secret",

        // English promotional phrases
        "highly recommend",
        "exceeded all my expectations",
        "game-changer",
        "exceptional quality",
        "worth every penny",
        "top-notch",
        "without a doubt",
        "excellent value",
        "perfect for anyone",
        "well-designed",
        "impressive",
        "outstanding performance",
        "i highly recommend this product",
        "overall, this product is an excellent choice",
        "the design and quality are exceptional",
        "it exceeded all my expectations",
        "i highly recommend this product to anyone",
        "this product offers great value for money",
        "the quality is outstanding",
        "it is easy to use and performs exceptionally well",

        // Tagalog promotional phrases
        "napakaganda ng kalidad",
        "talagang sulit sa presyo",
        "nagbibigay ng mahusay na karanasan"
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
       -1 EACH
    ====================================================== */

    clickbaitMatches.forEach(
        word => {

            credibility -=
                1;


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
       -1 EACH
    ====================================================== */

    misleadingMatches.forEach(
        word => {

            credibility -=
                1;


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
        "LOW LANGUAGE RISK";


    if (
        credibility >=
        50 &&
        credibility <=
        79
    ) {

        status =
            "MODERATE LANGUAGE RISK";

    } else if (
        credibility <
        50
    ) {

        status =
            "HIGH LANGUAGE RISK";
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


    let rawText =
        fullText?.text ||
        "";

    /* Screenshots and scattered text: retry with sparse-text detection. */
    if (!rawText.trim()) {
        try {
            const [fallback] =
                await visionClient.textDetection({
                    image: {
                        source: {
                            filename: filePath
                        }
                    }
                });
            rawText =
                fallback?.fullTextAnnotation?.text ||
                fallback?.textAnnotations?.[0]?.description ||
                "";
        } catch (fallbackError) {
            console.warn(
                "Vision sparse-text fallback failed:",
                fallbackError.message
            );
        }
    }


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
   FILE TEXT HELPERS
========================================================= */

const MAX_TEXT_CHARS = 20000;
const MAX_PDF_PAGES = 100;
const MAX_PDF_OCR_PAGES = 5;

/* Reads TXT files correctly even with a BOM, UTF-16, or old Windows encodings. */
function decodeTextBuffer(buf) {
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return buf.subarray(3).toString("utf8");
    }
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        return buf.subarray(2).toString("utf16le");
    }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
        const swapped = Buffer.from(buf.subarray(2));
        const even = swapped.subarray(0, swapped.length - (swapped.length % 2));
        even.swap16();
        return even.toString("utf16le");
    }
    const utf8 = buf.toString("utf8");
    return utf8.includes("\uFFFD") ? buf.toString("latin1") : utf8;
}

/* Joins lines that PDFs and scans break in the middle of a sentence. */
function reflowExtractedText(text) {
    return String(text || "")
        .replace(/\r/g, "")
        .replace(/\f/g, "\n\n")
        .replace(/(\w)-\n(?=[a-z])/g, "$1")
        .replace(/([^\n.!?:;"”)\]])\n(?!\n|\s*(?:[-•*]|\d+[.)])\s)/g, "$1 ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/* OCR for scanned PDFs (first pages only) using Google Vision. */
async function ocrPdfWithVision(buffer, pages) {
    if (!visionClient) {
        return "";
    }
    const pageList = Array.from({ length: Math.max(1, pages) }, (_, i) => i + 1);
    const [response] = await visionClient.batchAnnotateFiles({
        requests: [{
            inputConfig: {
                content: buffer,
                mimeType: "application/pdf"
            },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            pages: pageList
        }]
    });
    const responses = response?.responses?.[0]?.responses || [];
    return responses
        .map(item => item.fullTextAnnotation?.text || "")
        .filter(Boolean)
        .join("\n\n");
}

/* =========================================================
   POST /analyze-file
========================================================= */

app.post(
    "/analyze-file",
    fileUpload.single("file"),
    async (req, res) => {

        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded." });
        }

        const ext = path.extname(req.file.originalname || "").toLowerCase();

        try {

            let extractedText = "";
            let ocrUsed = false;
            let pageCount = null;
            let ocrPages = 0;

            if (ext === ".txt") {

                extractedText = cleanText(
                    decodeTextBuffer(fs.readFileSync(req.file.path))
                );

            } else if (ext === ".pdf") {

                const buffer = fs.readFileSync(req.file.path);

                let data;

                try {
                    data = await pdfParse(buffer, { max: MAX_PDF_PAGES });
                } catch (pdfError) {
                    console.error("PDF PARSE ERROR:", pdfError.message);
                    throw new Error(
                        "This PDF could not be opened. It may be password-protected or damaged."
                    );
                }

                pageCount = data.numpages || null;

                extractedText = reflowExtractedText(data.text || "");

                const pagesRead = Math.max(
                    1,
                    Math.min(pageCount || 1, MAX_PDF_PAGES)
                );

                const looksScanned =
                    extractedText.replace(/\s/g, "").length < 40 * pagesRead;

                if (looksScanned) {

                    if (!visionClient) {

                        if (!extractedText) {
                            throw new Error(
                                "This PDF looks scanned (it only contains images) and OCR is not available right now. Upload photos of the pages instead."
                            );
                        }

                    } else {

                        try {

                            ocrPages = Math.min(
                                pageCount || 1,
                                MAX_PDF_OCR_PAGES
                            );

                            const ocrText = reflowExtractedText(
                                await ocrPdfWithVision(buffer, ocrPages)
                            );

                            if (ocrText.length > extractedText.length) {
                                extractedText = ocrText;
                                ocrUsed = true;
                            }

                        } catch (ocrError) {

                            console.error("PDF OCR ERROR:", ocrError.message);

                            if (!extractedText) {
                                throw new Error(
                                    "This PDF looks scanned and could not be read with OCR. Try uploading photos of the pages instead."
                                );
                            }
                        }
                    }
                }

            } else if (ext === ".docx") {

                const result = await mammoth.extractRawText({
                    path: req.file.path
                });

                extractedText = cleanText(result.value || "");

            } else {

                throw new Error("Unsupported file type. Use TXT, PDF, or DOCX.");
            }

            extractedText = cleanText(extractedText);

            if (!extractedText) {
                throw new Error("No readable text was found in this file.");
            }

            const truncated =
                extractedText.length > MAX_TEXT_CHARS ||
                (pageCount !== null && pageCount > MAX_PDF_PAGES);

            if (extractedText.length > MAX_TEXT_CHARS) {
                extractedText = extractedText.slice(0, MAX_TEXT_CHARS);
            }

            const analysis = analyzeText(extractedText);

            return res.json({
                ...analysis,
                text: extractedText,
                highlightedWords: getHighlightedWordsFromText(extractedText),
                contentType: "file",
                ocrUsed,
                ocrPages,
                pageCount,
                truncated
            });

        } catch (error) {

            console.error("FILE ANALYSIS ERROR:", error);

            return res.status(500).json({
                error: error.message || "Unable to read this file."
            });

        } finally {

            safeDelete(req.file.path);
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


        const message =


            err.code === "LIMIT_FILE_SIZE"


                ? "That file is too large. Photos can be up to 10 MB and documents up to 20 MB."


                : (err.message || "Server error.");


        


        return res.status(status).json({

            error: message

        });
    }
);


/* =========================================================
   SERVE FRONTEND
========================================================= */

const PUBLIC_FILES = new Set([
    "index.html", "about.html", "history.html", "how-to-use.html",
    "styles.css", "script.js", "config.js",
    "logo.png", "favicon.png"
]);

app.get("/", (req, res) => {
    res.sendFile(path.join(BASE_DIR, "index.html"));
});

app.get("/:file", (req, res, next) => {
    if (!PUBLIC_FILES.has(req.params.file)) {
        return next();
    }
    res.sendFile(path.join(BASE_DIR, req.params.file), error => {
        if (error && !res.headersSent) {
            res.status(404).end();
        }
    });
});


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

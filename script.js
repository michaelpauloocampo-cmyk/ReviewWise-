"use strict";

/* =========================================================
   REVIEWWISE CONFIGURATION
========================================================= */

const API_BASE = "https://reviewwise.onrender.com";

const REQUEST_TIMEOUT_MS = 45000;
const MAX_HISTORY_ITEMS = 50;
const HOW_TO_USE_SEEN_KEY = "reviewwiseSeenHowToUse";

let uploadedFile = null;
let uploadedFileKind = null;

let cameraStream = null;
let capturedCameraBlob = null;
let currentPreviewObjectURL = null;
let currentVideoObjectURL = null;

let isProcessing = false;

/* Speech-to-text state */
let speechRecognition = null;
let isListening = false;

/* Most recent OCR result */
let lastOcrRaw = "";
let lastOcrClean = "";
let lastOcrQuality = null;
let lastOcrSourceKind = null;

/* Drag & drop counter */
let dragDepth = 0;


/* =========================================================
   SUSPICIOUS WORDS
========================================================= */

const suspiciousWords = [
    "shocking",
    "breaking",
    "viral",
    "secret",
    "101%",
    "guaranteed",
    "unbelievable",
    "click here",
    "share this"
];


/* =========================================================
   PATTERN INFORMATION
========================================================= */

const patternDefinitions = {

    suspicious: {
        label: "Suspicious Words",
        icon: "⚠️"
    },

    clickbait: {
        label: "Clickbait Language",
        icon: "🎯"
    },

    misleading: {
        label: "Exaggerated Claims",
        icon: "⚠️"
    },

    punctuation: {
        label: "Excessive Punctuation",
        icon: "❗"
    },

    emotional: {
        label: "Emotional Language",
        icon: "💬"
    }
};


/* =========================================================
   DOM HELPER
========================================================= */

function $(id) {
    return document.getElementById(id);
}


/* =========================================================
   HTML ESCAPING
========================================================= */

function escapeHtml(text) {

    const div = document.createElement("div");

    div.textContent = text ?? "";

    return div.innerHTML;
}


/* =========================================================
   REGEX ESCAPING
========================================================= */

function escapeRegex(str) {

    return String(str).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
    );
}


/* =========================================================
   NORMALIZE TEXT
========================================================= */

function normalizeForMatching(text) {

    return String(text || "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}


/* =========================================================
   FETCH WITH TIMEOUT
========================================================= */

async function fetchWithTimeout(url, options = {}) {

    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS
    );

    try {

        return await fetch(
            url,
            {
                ...options,
                signal: controller.signal
            }
        );

    } finally {

        clearTimeout(timer);

    }
}


/* =========================================================
   JSON RESPONSE
========================================================= */

async function getJsonResponse(response) {

    const contentType =
        response.headers.get("content-type") || "";

    const text = await response.text();

    if (contentType.includes("application/json")) {

        let data;

        try {

            data = JSON.parse(text);

        } catch {

            throw new Error(
                "The server returned invalid JSON."
            );
        }

        if (!response.ok) {

            throw new Error(
                data.error ||
                `Server error: ${response.status}`
            );
        }

        return data;
    }

    if (!response.ok) {

        const cleanText =
            text
                .replace(/<[^>]*>/g, " ")
                .replace(/\s+/g, " ")
                .trim();

        throw new Error(
            cleanText ||
            `Server error: ${response.status}`
        );
    }

    throw new Error(
        "The server returned an unexpected response."
    );
}


/* =========================================================
   TOAST
========================================================= */

let toastTimer = null;

function showToast(message, type = "success") {

    const toast = $("toast");
    const toastMessage = $("toastMessage");
    const toastIcon = $("toastIcon");

    if (!toast || !toastMessage) {
        return;
    }

    toastMessage.textContent = message;

    if (toastIcon) {

        toastIcon.textContent =
            type === "error"
                ? "!"
                : type === "warning"
                    ? "!"
                    : "✓";

        toastIcon.style.background =
            type === "error"
                ? "#dc2626"
                : type === "warning"
                    ? "#f59e0b"
                    : "#16a34a";
    }

    toast.classList.remove("hidden");

    requestAnimationFrame(() => {

        toast.classList.add("show");

    });

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {

        toast.classList.remove("show");

        setTimeout(() => {

            toast.classList.add("hidden");

        }, 250);

    }, 3000);
}


/* =========================================================
   STATUS MESSAGE
========================================================= */

function setStatus(message, visible = true) {

    const status = $("ocrStatus");

    if (!status) {
        return;
    }

    status.textContent = message || "";

    status.classList.toggle(
        "hidden",
        !visible
    );
}


/* =========================================================
   LOADING
========================================================= */

function setLoading(
    state,
    message = "Analyzing..."
) {

    isProcessing = Boolean(state);

    const button = $("generateButton");

    if (button) {

        button.disabled = state;

        button.innerHTML =
            state
                ? `<span>${escapeHtml(message)}</span><span>...</span>`
                : `<span>Analyze Content</span><span>→</span>`;
    }
}


/* =========================================================
   CHARACTER COUNT
========================================================= */

function updateCharacterCount() {

    const input = $("newsInput");
    const counter = $("characterCount");

    if (!input || !counter) {
        return;
    }

    const count = input.value.length;

    counter.textContent =
        `${count.toLocaleString()} characters`;
}


/* =========================================================
   WORD COUNT
========================================================= */

function updateWordCount() {

    const input = $("newsInput");
    const counter = $("wordCount");

    if (!input || !counter) {
        return;
    }

    const words =
        input.value.trim().length
            ? input.value.trim().split(/\s+/)
            : [];

    counter.textContent =
        `${words.length.toLocaleString()} words`;
}


/* =========================================================
   IMAGE METADATA
========================================================= */

function formatFileSize(bytes) {

    if (!Number.isFinite(bytes)) {
        return "";
    }

    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}


function updateImageMeta(file, width, height) {

    const meta = $("imageMeta");

    if (!meta) {
        return;
    }

    const parts = [];

    if (file?.name) {

        parts.push(
            `<span><strong>${escapeHtml(file.name)}</strong></span>`
        );
    }

    if (Number.isFinite(file?.size)) {

        parts.push(
            `<span>${formatFileSize(file.size)}</span>`
        );
    }

    if (width && height) {

        parts.push(
            `<span>${width} × ${height}px</span>`
        );
    }

    if (parts.length === 0) {

        meta.classList.add("hidden");
        return;
    }

    meta.innerHTML = parts.join("");

    meta.classList.remove("hidden");
}


/* =========================================================
   SCORE STATUS
========================================================= */

function getScoreLevel(score) {

    const value = Number(score) || 0;

    if (value >= 80) {

        return {
            key: "high",
            label: "HIGH CREDIBILITY",
            description:
                "Few risk indicators were detected in the language."
        };
    }

    if (value >= 50) {

        return {
            key: "medium",
            label: "MODERATE CREDIBILITY",
            description:
                "Some language patterns may warrant additional verification."
        };
    }

    return {
        key: "low",
        label: "LOW CREDIBILITY",
        description:
            "Several risk indicators were detected. Verify important claims carefully."
    };
}


/* =========================================================
   SCORE COLOR
========================================================= */

function getScoreColor(score) {

    const value = Number(score) || 0;

    if (value >= 80) {
        return "#16a34a";
    }

    if (value >= 50) {
        return "#f59e0b";
    }

    return "#dc2626";
}


/* =========================================================
   STATUS CLASS
========================================================= */

function statusClass(status, credibility) {

    const score = Number(credibility);

    if (Number.isFinite(score)) {

        return getScoreLevel(score).key;

    }

    const normalized =
        String(status || "").toLowerCase();

    if (normalized.includes("high")) {
        return "high";
    }

    if (
        normalized.includes("medium") ||
        normalized.includes("moderate")
    ) {
        return "medium";
    }

    return "low";
}


/* =========================================================
   GRAPH BAR
========================================================= */

function setBar(id, value) {

    const el = $(id);

    if (!el) {
        return;
    }

    const v =
        Math.max(
            0,
            Math.min(
                100,
                Math.round(Number(value) || 0)
            )
        );

    el.style.height = `${v}%`;

    const valueSpan =
        el.querySelector(".vbar-value");

    if (valueSpan) {

        valueSpan.textContent =
            `${v}%`;
    }
}


/* =========================================================
   GET SUSPICIOUS WORDS
========================================================= */

function getSuspiciousWords(backendWords = []) {

    const words = [];

    if (Array.isArray(backendWords)) {

        backendWords.forEach(word => {

            if (word && word.text) {

                words.push({
                    text: String(word.text),
                    category:
                        word.category ||
                        "suspicious"
                });
            }

        });
    }

    suspiciousWords.forEach(word => {

        const exists =
            words.some(
                item =>
                    normalizeForMatching(item.text) ===
                    normalizeForMatching(word)
            );

        if (!exists) {

            words.push({
                text: word,
                category: "suspicious"
            });
        }

    });

    const seen = new Set();

    const unique =
        words.filter(item => {

            const key =
                normalizeForMatching(item.text);

            if (!key || seen.has(key)) {
                return false;
            }

            seen.add(key);

            return true;
        });

    unique.sort(
        (a, b) =>
            b.text.length -
            a.text.length
    );

    return unique;
}


/* =========================================================
   HIGHLIGHT SUSPICIOUS WORDS
========================================================= */

function highlightSuspiciousWords(
    text,
    backendWords = []
) {

    if (!text) {
        return "";
    }

    const words =
        getSuspiciousWords(backendWords);

    if (words.length === 0) {
        return escapeHtml(text);
    }

    const patterns =
        words
            .map(
                item =>
                    escapeRegex(
                        item.text.trim()
                    )
            )
            .filter(Boolean)
            .sort(
                (a, b) =>
                    b.length -
                    a.length
            );

    if (patterns.length === 0) {
        return escapeHtml(text);
    }

    const regex =
        new RegExp(
            `(?<![A-Za-z0-9])(${patterns.join("|")})(?![A-Za-z0-9])`,
            "gi"
        );

    let html = "";
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {

        html += escapeHtml(
            text.slice(
                lastIndex,
                match.index
            )
        );

        html +=
            `<span class="highlight highlight-suspicious" title="Suspicious language">${escapeHtml(match[0])}</span>`;

        lastIndex =
            match.index +
            match[0].length;
    }

    html += escapeHtml(
        text.slice(lastIndex)
    );

    return html;
}


/* =========================================================
   BUILD DYNAMIC EXPLANATIONS
========================================================= */

function buildDynamicExplanations(analysis) {

    const explanations = [];

    if (analysis.ocrLowConfidence) {

        explanations.push({
            icon: "🔍",
            text:
                `OCR quality for this image was low (${analysis.ocrQuality}%), so suspicious-word penalties were reduced and this score should be treated as less certain than usual.`
        });
    }

    const text =
        String(analysis.text || "");

    const lower =
        normalizeForMatching(text);

    const backendWords =
        getSuspiciousWords(
            analysis.highlightedWords || []
        );

    backendWords.forEach(item => {

        const normalizedWord =
            normalizeForMatching(item.text);

        if (!lower.includes(normalizedWord)) {
            return;
        }

        let message =
            "This wording may deserve additional verification.";

        const word = item.text;

        if (
            normalizedWord === "breaking" ||
            normalizedWord === "shocking" ||
            normalizedWord === "viral"
        ) {

            message =
                `"${word}" uses attention-grabbing language that may create urgency or emotional reaction.`;
        }

        else if (
            normalizedWord === "guaranteed" ||
            normalizedWord === "101%" ||
            normalizedWord === "unbelievable"
        ) {

            message =
                `"${word}" makes an absolute or exaggerated claim that may require supporting evidence.`;
        }

        else if (
            normalizedWord === "secret"
        ) {

            message =
                `"${word}" can create curiosity or imply hidden information without providing evidence.`;
        }

        else if (
            normalizedWord === "click here" ||
            normalizedWord === "share this"
        ) {

            message =
                `"${word}" encourages immediate interaction or sharing rather than careful verification.`;
        }

        explanations.push({
            icon: "⚠️",
            text: message
        });
    });


    const exclamationCount =
        (
            text.match(/!/g) || []
        ).length;

    if (exclamationCount >= 3) {

        explanations.push({

            icon: "❗",

            text:
                `The content contains ${exclamationCount} exclamation marks, which may contribute to an emotionally urgent tone.`

        });
    }


    if (explanations.length === 0) {

        explanations.push({

            icon: "✓",

            text:
                "No major suspicious language patterns were detected. This does not guarantee that the information is factually correct."

        });
    }

    return explanations;
}


/* =========================================================
   GET BREAKDOWN COUNTS
========================================================= */

function getBreakdown(analysis) {

    const text =
        String(analysis.text || "");

    const lower =
        normalizeForMatching(text);

    const clickbait =
        suspiciousWords.filter(
            word =>
                [
                    "shocking",
                    "breaking",
                    "viral",
                    "click here",
                    "share this"
                ].includes(word) &&
                lower.includes(
                    normalizeForMatching(word)
                )
        ).length;

    const misleading =
        suspiciousWords.filter(
            word =>
                [
                    "guaranteed",
                    "101%",
                    "unbelievable",
                    "secret"
                ].includes(word) &&
                lower.includes(
                    normalizeForMatching(word)
                )
        ).length;

    const punctuation =
        (
            text.match(/!/g) || []
        ).length;

    const suspicious =
        Number.isFinite(
            Number(analysis.suspiciousCount)
        )
            ? Number(analysis.suspiciousCount)
            : clickbait + misleading;

    return {

        suspicious:
            Math.max(
                suspicious,
                clickbait + misleading
            ),

        clickbait,

        misleading,

        punctuation,

        emotional:
            Math.min(
                100,
                punctuation * 15
            )
    };
}


/* =========================================================
   SAVE HISTORY
========================================================= */

function saveHistory(analysis) {

    try {

        let list =
            JSON.parse(
                localStorage.getItem(
                    "reviewwiseHistory"
                ) || "[]"
            );

        const text =
            String(analysis.text || "");

        const score =
            Number(analysis.credibility) || 0;

        const level =
            getScoreLevel(score);

        const type =
            analysis.contentType ||
            uploadedFileKind ||
            "text";

        const item = {

            id:
                Date.now() +
                "_" +
                Math.random()
                    .toString(36)
                    .slice(2, 8),

            text,

            snippet:
                text
                    .replace(/\s+/g, " ")
                    .slice(0, 100),

            credibility: score,

            status: level.label,

            risk: 100 - score,

            contentType: type,

            analysis: {
                ...analysis
            },

            time:
                new Date().toLocaleString()

        };

        list.unshift(item);

        list =
            list.slice(
                0,
                MAX_HISTORY_ITEMS
            );

        localStorage.setItem(
            "reviewwiseHistory",
            JSON.stringify(list)
        );

    } catch (error) {

        console.error(
            "History save error:",
            error
        );
    }
}


/* =========================================================
   RENDER ANALYSIS
========================================================= */

function renderAnalysis(analysis) {

    if (!analysis) {
        return;
    }

    const result = $("result");

    const highlightedContainer =
        $("highlightedContainer");

    if (!result || !highlightedContainer) {
        return;
    }

    const score =
        Math.max(
            0,
            Math.min(
                100,
                Number(analysis.credibility) || 0
            )
        );

    const level =
        getScoreLevel(score);

    const color =
        getScoreColor(score);

    const breakdown =
        getBreakdown(analysis);


    /* RESULT TYPE */

    const typeBadge =
        $("resultTypeBadge");

    if (typeBadge) {

        const type =
            analysis.contentType ||
            uploadedFileKind ||
            "text";

        typeBadge.textContent =
            String(type).toUpperCase();
    }


    /* SCORE */

    const scoreNumber =
        $("scoreNumber");

    if (scoreNumber) {
        scoreNumber.textContent = score;
    }


    const scoreLevel =
        $("scoreLevel");

    if (scoreLevel) {

        scoreLevel.textContent =
            level.label;

        scoreLevel.style.color =
            color;
    }


    const scoreDescription =
        $("scoreDescription");

    if (scoreDescription) {

        scoreDescription.textContent =
            level.description;
    }


    /* SCORE RING */

    const scoreRing =
        $("scoreRing");

    if (scoreRing) {

        scoreRing.style.setProperty(
            "--score",
            `${score}%`
        );

        scoreRing.style.background =
            `conic-gradient(${color} ${score}%, #e5e7eb ${score}%)`;
    }


    /* SCORE PROGRESS */

    const progress =
        $("scoreProgressBar");

    if (progress) {

        progress.style.width =
            `${score}%`;

        progress.style.background =
            color;
    }


    const progressValue =
        $("scoreProgressValue");

    if (progressValue) {

        progressValue.textContent =
            `${score} / 100`;
    }


    /* PATTERN BREAKDOWN */

    const breakdownContainer =
        $("patternBreakdown");

    if (breakdownContainer) {

        const items = [

            {
                key: "suspicious",
                value: breakdown.suspicious
            },

            {
                key: "punctuation",
                value: breakdown.punctuation
            },

            {
                key: "emotional",
                value: breakdown.emotional
            }

        ];

        breakdownContainer.innerHTML =
            items
                .map(item => {

                    const def =
                        patternDefinitions[item.key];

                    return `

                        <div class="pattern-item">

                            <div class="pattern-item-header">

                                <span class="pattern-icon">
                                    ${def.icon}
                                </span>

                                <strong>
                                    ${escapeHtml(def.label)}
                                </strong>

                            </div>

                            <span class="pattern-count">

                                ${Number(item.value) || 0}

                                detected

                            </span>

                        </div>

                    `;
                })
                .join("");
    }


    /* EXPLANATIONS */

    const detailed =
        $("detailedExplanations");

    if (detailed) {

        const explanations =
            buildDynamicExplanations(analysis);

        detailed.innerHTML =
            explanations
                .map(
                    item => `

                        <div class="explanation-item">

                            <span class="explanation-icon">
                                ${item.icon}
                            </span>

                            <span>
                                ${escapeHtml(item.text)}
                            </span>

                        </div>

                    `
                )
                .join("");
    }


    /* GRAPH */

    setBar(
        "credibleBar",
        score
    );

    setBar(
        "suspiciousBar",
        100 - score
    );


    /* HIGHLIGHTED TEXT */

    const output =
        analysis.text || "";

    const highlightedText =
        $("highlightedText");

    if (highlightedText) {

        highlightedText.innerHTML =
            highlightSuspiciousWords(
                output,
                analysis.highlightedWords || []
            );
    }


    /* LEGACY EXPLANATION */

    const explanation =
        $("explanation");

    if (explanation) {

        explanation.textContent =
            level.description;
    }


    result.classList.remove("hidden");

    highlightedContainer.classList.remove("hidden");


    saveHistory(analysis);


    setTimeout(() => {

        result.scrollIntoView({
            behavior: "smooth",
            block: "start"
        });

    }, 100);
}


/* =========================================================
   ANALYZE TEXT
========================================================= */

async function analyzeTextInput(
    text,
    options = {}
) {

    const ocrQuality =
        Number.isFinite(options.ocrQuality)
            ? options.ocrQuality
            : null;

    if (!text || !text.trim()) {

        showToast(
            "Please provide text to analyze.",
            "warning"
        );

        return;
    }

    setLoading(
        true,
        "Preparing..."
    );

    setStatus(
        "Preparing content for analysis...",
        true
    );

    try {

        setLoading(
            true,
            "Analyzing credibility..."
        );

        const response =
            await fetchWithTimeout(
                `${API_BASE}/analyze`,
                {

                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            text
                        })
                }
            );

        const data =
            await getJsonResponse(response);

        data.contentType = "text";


        /*
         * LOW OCR QUALITY DAMPENING
         */

        if (
            ocrQuality !== null &&
            ocrQuality < 60
        ) {

            const weight =
                Math.max(
                    0.35,
                    ocrQuality / 60
                );

            const original =
                Number(data.credibility) || 0;

            const damped =
                Math.round(
                    original * weight +
                    75 * (1 - weight)
                );

            data.credibility = damped;

            data.suspicious =
                100 - damped;

            data.ocrLowConfidence = true;

            data.ocrQuality =
                ocrQuality;
        }


        renderAnalysis(data);

        setStatus(
            "Analysis complete.",
            true
        );

    } catch (error) {

        console.error(
            "TEXT ANALYSIS ERROR:",
            error
        );

        handleRequestError(
            error,
            "Unable to analyze the text."
        );

    } finally {

        setLoading(false);
    }
}


/* =========================================================
   GENERATE RESULT
========================================================= */

async function generateResult() {

    if (isProcessing) {
        return;
    }

    const input =
        $("newsInput");

    if (!input) {
        return;
    }

    const text =
        input.value.trim();


    if (!text && !uploadedFile) {

        showToast(
            "Paste text or upload content first.",
            "warning"
        );

        input.focus();

        return;
    }


    /* IMAGE */

    if (
        uploadedFile &&
        uploadedFileKind === "image"
    ) {

        return analyzeMedia(
            uploadedFile,
            "photo",
            "/analyze-image",
            "image"
        );
    }


    /* VIDEO */

    if (
        uploadedFile &&
        uploadedFileKind === "video"
    ) {

        return analyzeMedia(
            uploadedFile,
            "video",
            "/analyze-video",
            "video"
        );
    }


    /* FILE */

    if (
        uploadedFile &&
        uploadedFileKind === "file"
    ) {

        return analyzeMedia(
            uploadedFile,
            "file",
            "/analyze-file",
            "file"
        );
    }


    /* TEXT */

    await analyzeTextInput(text);
}


/* =========================================================
   ANALYZE MEDIA
========================================================= */

async function analyzeMedia(
    file,
    fieldName,
    endpoint,
    contentType
) {

    if (!file) {
        return;
    }

    setLoading(
        true,
        contentType === "video"
            ? "Scanning video..."
            : "Processing..."
    );


    if (contentType === "video") {

        showVideoProgress(
            10,
            "Uploading video..."
        );

    } else {

        setStatus(
            contentType === "image"
                ? "Processing image..."
                : "Extracting file text...",
            true
        );
    }


    try {

        const formData =
            new FormData();

        formData.append(
            fieldName,
            file
        );


        if (contentType === "video") {

            showVideoProgress(
                20,
                "Scanning video frames..."
            );
        }


        const response =
            await fetchWithTimeout(
                `${API_BASE}${endpoint}`,
                {
                    method: "POST",
                    body: formData
                }
            );


        if (contentType === "video") {

            showVideoProgress(
                85,
                "Analyzing extracted text..."
            );

        } else {

            setStatus(
                "Analyzing extracted content...",
                true
            );
        }


        const data =
            await getJsonResponse(response);

        data.contentType =
            contentType;


        renderAnalysis(data);


        if (
            endpoint === "/analyze-image"
        ) {

            drawHighlightBoxes(
                data.highlightedWords || []
            );
        }


        if (contentType === "video") {

            showVideoProgress(
                100,
                "Video scan complete."
            );

            setTimeout(
                () => {
                    hideVideoProgress();
                },
                1000
            );
        }


        showToast(
            "Analysis complete."
        );


    } catch (error) {

        console.error(
            "MEDIA ANALYSIS ERROR:",
            error
        );

        if (contentType === "video") {
            hideVideoProgress();
        }

        handleRequestError(
            error,
            "Unable to process this content."
        );

    } finally {

        setLoading(false);
    }
}


/* =========================================================
   REQUEST ERROR HANDLING
========================================================= */

function handleRequestError(
    error,
    fallback
) {

    if (
        error &&
        error.name === "AbortError"
    ) {

        showToast(
            "The request timed out. Please try again.",
            "error"
        );

        setStatus(
            "The request timed out. Please try again.",
            true
        );

        return;
    }


    let message =
        String(
            error?.message || ""
        );


    const looksLikeRawJsError =
        /cannot read propert|undefined is not|is not a function|is not defined|null is not an object/i
            .test(message);

    if (
        !message ||
        looksLikeRawJsError
    ) {

        message = "";
    }


    if (
        message
            .toLowerCase()
            .includes("failed to fetch")
    ) {

        showToast(
            "Unable to connect to ReviewWise server.",
            "error"
        );

        setStatus(
            "Server unavailable. Make sure the ReviewWise backend is running.",
            true
        );

        return;
    }


    showToast(
        message || fallback,
        "error"
    );

    setStatus(
        message || fallback,
        true
    );
}


/* =========================================================
   COPY RESULT
========================================================= */

function copyResultText() {

    const input = $("newsInput");

    const text =
        input ? input.value : "";

    if (!text.trim()) {

        showToast(
            "There's no analyzed text to copy yet.",
            "warning"
        );

        return;
    }

    navigator.clipboard
        ?.writeText(text)
        .then(
            () => showToast("Copied!")
        )
        .catch(
            () =>
                showToast(
                    "Unable to copy text.",
                    "error"
                )
        );
}


/* =========================================================
   DOWNLOAD REPORT
========================================================= */

function downloadReport() {

    const resultSection =
        $("result");

    if (
        !resultSection ||
        resultSection.classList.contains("hidden")
    ) {

        showToast(
            "Run an analysis first.",
            "warning"
        );

        return;
    }

    const score =
        $("scoreNumber")?.textContent?.trim() || "0";

    const level =
        $("scoreLevel")?.textContent?.trim() || "";

    const text =
        $("newsInput")?.value || "";

    const ocrBadge =
        $("ocrQualityBadge");

    const ocrQuality =
        ocrBadge &&
        !ocrBadge.closest(".hidden")
            ? ocrBadge.textContent.trim()
            : "N/A";

    const explanationItems =
        Array.from(
            document.querySelectorAll(
                "#detailedExplanations .explanation-item"
            )
        )
        .map(
            el =>
                `- ${el.textContent.replace(/\s+/g, " ").trim()}`
        );

    const highlighted =
        getSuspiciousWords()
            .filter(
                w =>
                    normalizeForMatching(text)
                        .includes(
                            normalizeForMatching(w.text)
                        )
            )
            .map(
                w => w.text
            );

    const lines = [

        "ReviewWise — Credibility Report",

        "================================",

        "",

        `Date: ${new Date().toLocaleString()}`,

        `Credibility Score: ${score} / 100`,

        `Credibility Level: ${level}`,

        `OCR Quality: ${ocrQuality}`,

        "",

        "Analyzed Text:",

        "--------------",

        text || "(none)",

        "",

        "Suspicious Words:",

        "-----------------",

        highlighted.length
            ? highlighted.join(", ")
            : "None detected",

        "",

        "Why this score?",

        "----------------",

        explanationItems.length
            ? explanationItems.join("\n")
            : "No detailed explanations available.",

        "",

        "This report is a risk indicator, not a fact-check.",

        "Always verify important claims with reliable sources."

    ];

    const blob =
        new Blob(
            [lines.join("\n")],
            {
                type:
                    "text/plain;charset=utf-8"
            }
        );

    const url =
        URL.createObjectURL(blob);

    const a =
        document.createElement("a");

    a.href = url;

    a.download =
        `reviewwise-report-${Date.now()}.txt`;

    document.body.appendChild(a);

    a.click();

    a.remove();

    setTimeout(
        () => URL.revokeObjectURL(url),
        1000
    );

    showToast(
        "Report downloaded."
    );
}


/* =========================================================
   SPEECH TO TEXT
========================================================= */

function toggleSpeechToText() {

    const SpeechRecognitionClass =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {

        showToast(
            "Speech-to-text isn't supported in this browser.",
            "error"
        );

        return;
    }

    if (isListening) {

        speechRecognition?.stop();

        return;
    }

    /* Never allow two recognition instances to run
       at once — if a stale instance is somehow still
       around, forcibly tear it down first. */
    if (speechRecognition) {

        try {

            speechRecognition.onend = null;
            speechRecognition.onresult = null;
            speechRecognition.onerror = null;

            speechRecognition.stop();

        } catch {

            /* ignore — instance may already be dead */
        }

        speechRecognition = null;
    }

    const input = $("newsInput");
    const micButton = $("micButton");
    const micLabel = $("micLabel");
    const micIcon = $("micIcon");

    speechRecognition =
        new SpeechRecognitionClass();

    speechRecognition.lang = "en-US";
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.maxAlternatives = 1;

    /* ---------------------------------------------------
       TEXT STATE

       originalText  — whatever was already in the textarea
                       before the mic was pressed. Never
                       touched again for this session.
       finalSpeech   — confirmed/final speech, committed
                       exactly once per unique final result.
       interimSpeech — temporary in-progress speech. Fully
                       recomputed on every onresult event,
                       so it can never itself duplicate.
    --------------------------------------------------- */

    const originalText =
        input ? input.value : "";

    const originalTextWithSpacer =
        originalText &&
        !/\s$/.test(originalText)

            ? originalText + " "
            : originalText;

    let finalSpeech = "";
    let interimSpeech = "";

    /* Guards against Chrome/Android redelivering a final
       result: once, by result index (normal case), and
       again by normalized text (covers the case where the
       same phrase reappears under a different/reset index,
       which is the real cause of "hello world hello world"
       style duplication on mobile Chrome). */
    const committedIndices = new Set();
    let lastCommittedNormalized = "";

    function normalizeChunk(text) {

        return text
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ");
    }

    function renderTranscript() {

        if (!input) {
            return;
        }

        input.value = (
            originalTextWithSpacer +
            finalSpeech +
            interimSpeech
        ).replace(/[ \t]+/g, " ");

        updateCharacterCount();
        updateWordCount();
    }

    speechRecognition.onstart = () => {

        isListening = true;

        micButton?.classList.add(
            "listening"
        );

        if (micLabel) {
            micLabel.textContent =
                "Listening…";
        }

        if (micIcon) {
            micIcon.textContent =
                "⏺";
        }
    };

    speechRecognition.onresult =
        event => {

            /* Interim text is rebuilt from scratch every
               event — it is never appended to, so it can
               never itself cause a permanent duplicate. */
            interimSpeech = "";

            for (
                let i = 0;
                i < event.results.length;
                i++
            ) {

                const result =
                    event.results[i];

                const transcriptChunk =
                    result[0].transcript;

                if (result.isFinal) {

                    if (
                        committedIndices.has(i)
                    ) {

                        /* Already committed this exact
                           result index — skip. */
                        continue;
                    }

                    const normalized =
                        normalizeChunk(
                            transcriptChunk
                        );

                    committedIndices.add(i);

                    if (!normalized) {
                        continue;
                    }

                    if (
                        normalized ===
                        lastCommittedNormalized
                    ) {

                        /* Same phrase redelivered under a
                           new/reset index — skip it so the
                           sentence isn't added twice. */
                        continue;
                    }

                    finalSpeech +=
                        transcriptChunk.trim() + " ";

                    lastCommittedNormalized =
                        normalized;

                } else {

                    interimSpeech +=
                        transcriptChunk;
                }
            }

            renderTranscript();
        };

    speechRecognition.onerror =
        event => {

            console.error(
                "Speech recognition error:",
                event.error
            );

            if (
                event.error !== "no-speech"
            ) {

                showToast(
                    "Speech recognition ran into an issue. Please try again.",
                    "error"
                );
            }
        };

    speechRecognition.onend = () => {

        isListening = false;

        /* Drop any leftover interim text so a result that
           never finalized before the session ended (e.g.
           the browser auto-stopping after silence) can't
           linger, and can't be duplicated if the mic is
           pressed again. */
        interimSpeech = "";

        renderTranscript();

        micButton?.classList.remove(
            "listening"
        );

        if (micLabel) {
            micLabel.textContent =
                "Speak";
        }

        if (micIcon) {
            micIcon.textContent =
                "";
        }

        speechRecognition = null;
    };

    try {

        speechRecognition.start();

    } catch (error) {

        console.error(
            "Unable to start speech recognition:",
            error
        );

        showToast(
            "Unable to start speech-to-text.",
            "error"
        );

        speechRecognition = null;
    }
}


/* =========================================================
   DRAG & DROP
========================================================= */

function routeDroppedFile(file) {

    if (!file) {
        return;
    }

    if (
        file.type.startsWith("image/")
    ) {

        runOCR(
            file,
            "photo"
        ).catch(
            error => {

                console.error(
                    "Dropped image OCR error:",
                    error
                );

                showToast(
                    "Unable to read text from this image. Try a clearer photo.",
                    "error"
                );
            }
        );

        return;
    }

    if (
        file.type.startsWith("video/")
    ) {

        const videoInput =
            $("video");

        if (videoInput) {

            const dt =
                new DataTransfer();

            dt.items.add(file);

            videoInput.files =
                dt.files;

            videoInput.dispatchEvent(
                new Event("change")
            );
        }

        return;
    }

    const extension =
        file.name
            .split(".")
            .pop()
            ?.toLowerCase();

    if (
        ["pdf", "docx", "txt"]
            .includes(extension)
    ) {

        const fileInput =
            $("file");

        if (fileInput) {

            const dt =
                new DataTransfer();

            dt.items.add(file);

            fileInput.files =
                dt.files;

            fileInput.dispatchEvent(
                new Event("change")
            );
        }

        return;
    }

    showToast(
        "Unsupported file type. Use an image, video, PDF, DOCX, or TXT.",
        "error"
    );
}


function setupDragAndDrop() {

    const dropOverlay =
        $("dropOverlay");

    if (!dropOverlay) {
        return;
    }

    [
        "dragenter",
        "dragover",
        "dragleave",
        "drop"
    ].forEach(
        eventName => {

            document.addEventListener(
                eventName,
                event => {

                    event.preventDefault();
                    event.stopPropagation();

                }
            );
        }
    );

    document.addEventListener(
        "dragenter",
        () => {

            dragDepth++;

            dropOverlay.classList.remove(
                "hidden"
            );
        }
    );

    document.addEventListener(
        "dragleave",
        () => {

            dragDepth =
                Math.max(
                    0,
                    dragDepth - 1
                );

            if (dragDepth === 0) {

                dropOverlay.classList.add(
                    "hidden"
                );
            }
        }
    );

    document.addEventListener(
        "drop",
        event => {

            dragDepth = 0;

            dropOverlay.classList.add(
                "hidden"
            );

            const file =
                event.dataTransfer
                    ?.files?.[0];

            if (!file) {
                return;
            }

            if (isProcessing) {

                showToast(
                    "Please wait for the current analysis to finish.",
                    "warning"
                );

                return;
            }

            routeDroppedFile(file);
        }
    );
}


/* =========================================================
   PLUS MENU
========================================================= */

function toggleMenu() {

    const menu = $("menu");
    const plus = $("plusButton");

    if (!menu) {
        return;
    }

    const opening =
        !menu.classList.contains("open");

    menu.classList.toggle(
        "open",
        opening
    );

    if (plus) {

        plus.classList.toggle(
            "menu-open",
            opening
        );
    }

    menu.setAttribute(
        "aria-hidden",
        String(!opening)
    );
}


function closeUploadMenu() {

    const menu = $("menu");
    const plus = $("plusButton");

    if (menu) {

        menu.classList.remove(
            "open"
        );

        menu.setAttribute(
            "aria-hidden",
            "true"
        );
    }

    if (plus) {

        plus.classList.remove(
            "menu-open"
        );
    }
}


/* =========================================================
   REAL CAMERA
========================================================= */

async function openCamera() {

    closeUploadMenu();

    const modal =
        $("cameraModal");

    const preview =
        $("cameraPreview");

    const status =
        $("cameraStatus");

    if (!modal || !preview) {

        showToast(
            "Camera interface is unavailable.",
            "error"
        );

        return;
    }

    modal.classList.remove("hidden");

    document.body.style.overflow =
        "hidden";

    resetCameraReview();


    if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
    ) {

        if (status) {

            status.textContent =
                "Your browser does not support live camera access.";
        }

        showToast(
            "Live camera is not supported by this browser.",
            "error"
        );

        return;
    }


    try {

        if (status) {

            status.textContent =
                "Requesting camera permission...";
        }

        cameraStream =
            await navigator.mediaDevices.getUserMedia({

                video: {

                    facingMode: {
                        ideal: "environment"
                    },

                    width: {
                        ideal: 1280
                    },

                    height: {
                        ideal: 720
                    }
                },

                audio: false

            });

        preview.srcObject =
            cameraStream;

        await preview.play()
            .catch(
                () => {}
            );

        if (status) {

            status.textContent =
                "Point the camera at readable text.";
        }

    } catch (error) {

        console.error(
            "Camera error:",
            error
        );

        let message =
            "Unable to access the camera.";

        if (
            error.name ===
            "NotAllowedError"
        ) {

            message =
                "Camera permission was denied. Allow camera access in your browser settings and try again.";
        }

        else if (
            error.name ===
            "NotFoundError"
        ) {

            message =
                "No camera was found on this device.";
        }

        else if (
            error.name ===
            "NotReadableError"
        ) {

            message =
                "The camera is currently being used by another application.";
        }

        else if (
            error.name ===
            "SecurityError"
        ) {

            message =
                "Camera access requires a secure connection such as HTTPS or localhost.";
        }

        if (status) {

            status.textContent =
                message;
        }

        showToast(
            message,
            "error"
        );
    }
}


/* =========================================================
   CAPTURE CAMERA
========================================================= */

function captureCamera() {

    const preview =
        $("cameraPreview");

    const canvas =
        $("cameraCanvas");

    const capturedImage =
        $("capturedImage");

    const review =
        $("cameraReview");

    const status =
        $("cameraStatus");

    if (
        !preview ||
        !canvas ||
        !preview.videoWidth ||
        !preview.videoHeight
    ) {

        showToast(
            "Camera is not ready yet.",
            "warning"
        );

        return;
    }

    const maxWidth = 1600;

    const scale =
        Math.min(
            1,
            maxWidth /
            preview.videoWidth
        );

    canvas.width =
        Math.round(
            preview.videoWidth *
            scale
        );

    canvas.height =
        Math.round(
            preview.videoHeight *
            scale
        );

    const ctx =
        canvas.getContext("2d");

    if (!ctx) {

        showToast(
            "Unable to capture camera image.",
            "error"
        );

        return;
    }

    ctx.drawImage(
        preview,
        0,
        0,
        canvas.width,
        canvas.height
    );

    canvas.toBlob(
        blob => {

            if (!blob) {

                showToast(
                    "Unable to create captured image.",
                    "error"
                );

                return;
            }

            capturedCameraBlob =
                blob;

            const url =
                URL.createObjectURL(blob);

            if (capturedImage) {

                capturedImage.src =
                    url;
            }

            if (review) {

                review.classList.remove(
                    "hidden"
                );
            }

            preview.classList.add(
                "hidden"
            );

            $("captureButton")
                ?.classList.add(
                    "hidden"
                );

            $("retakeButton")
                ?.classList.remove(
                    "hidden"
                );

            $("confirmButton")
                ?.classList.remove(
                    "hidden"
                );

            if (status) {

                status.textContent =
                    "Check the photo, then tap Use Photo.";
            }

            stopCameraStream();

        },
        "image/jpeg",
        0.92
    );
}


/* =========================================================
   RETAKE CAMERA
========================================================= */

async function retakeCamera() {

    resetCameraReview();

    await startCameraStream();
}


/* =========================================================
   START CAMERA STREAM
========================================================= */

async function startCameraStream() {

    const preview =
        $("cameraPreview");

    const status =
        $("cameraStatus");

    if (
        !preview ||
        !navigator.mediaDevices?.getUserMedia
    ) {
        return;
    }

    try {

        cameraStream =
            await navigator.mediaDevices.getUserMedia({

                video: {

                    facingMode: {
                        ideal: "environment"
                    },

                    width: {
                        ideal: 1280
                    },

                    height: {
                        ideal: 720
                    }
                },

                audio: false

            });

        preview.srcObject =
            cameraStream;

        preview.classList.remove(
            "hidden"
        );

        await preview.play()
            .catch(
                () => {}
            );

        if (status) {

            status.textContent =
                "Point the camera at readable text.";
        }

    } catch (error) {

        console.error(
            "Retake camera error:",
            error
        );

        showToast(
            "Unable to restart the camera.",
            "error"
        );
    }
}


/* =========================================================
   CONFIRM CAMERA CAPTURE
========================================================= */

async function confirmCameraCapture() {

    if (!capturedCameraBlob) {

        showToast(
            "No captured photo is available.",
            "warning"
        );

        return;
    }

    const status =
        $("cameraStatus");

    if (status) {

        status.textContent =
            "Processing captured image...";
    }

    const file =
        new File(
            [capturedCameraBlob],
            `reviewwise-camera-${Date.now()}.jpg`,
            {
                type: "image/jpeg"
            }
        );

    closeCamera();

    try {

        await runOCR(
            file,
            "camera"
        );

    } catch (error) {

        console.error(
            "Camera OCR error:",
            error
        );

        showToast(
            "Unable to read text from this image. Try a clearer or brighter photo.",
            "error"
        );
    }
}


/* =========================================================
   RESET CAMERA REVIEW
========================================================= */

function resetCameraReview() {

    const preview =
        $("cameraPreview");

    const review =
        $("cameraReview");

    const captured =
        $("capturedImage");

    if (preview) {

        preview.classList.remove(
            "hidden"
        );
    }

    if (review) {

        review.classList.add(
            "hidden"
        );
    }

    if (captured) {

        if (
            captured.src &&
            captured.src.startsWith("blob:")
        ) {

            URL.revokeObjectURL(
                captured.src
            );
        }

        captured.removeAttribute(
            "src"
        );
    }

    capturedCameraBlob = null;

    $("captureButton")
        ?.classList.remove(
            "hidden"
        );

    $("retakeButton")
        ?.classList.add(
            "hidden"
        );

    $("confirmButton")
        ?.classList.add(
            "hidden"
        );
}


/* =========================================================
   STOP CAMERA
========================================================= */

function stopCameraStream() {

    if (!cameraStream) {
        return;
    }

    cameraStream
        .getTracks()
        .forEach(
            track => track.stop()
        );

    cameraStream = null;

    const preview =
        $("cameraPreview");

    if (preview) {

        preview.srcObject = null;
    }
}


/* =========================================================
   CLOSE CAMERA
========================================================= */

function closeCamera() {

    stopCameraStream();

    resetCameraReview();

    const modal =
        $("cameraModal");

    if (modal) {

        modal.classList.add(
            "hidden"
        );
    }

    document.body.style.overflow = "";
}


/* =========================================================
   PHOTO PICKER
========================================================= */

function openPhotoPicker() {

    closeUploadMenu();

    const photo =
        $("photo");

    if (!photo) {

        showToast(
            "Photo picker is unavailable.",
            "error"
        );

        return;
    }

    photo.click();
}


function setupPhoto() {

    const photo =
        $("photo");

    if (!photo) {
        return;
    }

    photo.addEventListener(
        "change",
        async function () {

            const file =
                this.files?.[0];

            if (!file) {
                return;
            }

            if (
                !file.type.startsWith("image/")
            ) {

                showToast(
                    "Please select an image.",
                    "error"
                );

                this.value = "";

                return;
            }

            try {

                await runOCR(
                    file,
                    "photo"
                );

            } catch (error) {

                console.error(
                    "Photo OCR error:",
                    error
                );

            } finally {

                this.value = "";
            }
        }
    );
}


/* =========================================================
   SHOW IMAGE PREVIEW
========================================================= */

function showImagePreview(file) {

    const imageContainer =
        $("imageContainer");

    const previewImage =
        $("previewImage");

    if (!previewImage) {
        return;
    }

    if (currentPreviewObjectURL) {

        URL.revokeObjectURL(
            currentPreviewObjectURL
        );
    }

    const imageURL =
        URL.createObjectURL(file);

    currentPreviewObjectURL =
        imageURL;

    previewImage.src =
        imageURL;

    if (imageContainer) {

        imageContainer.classList.remove(
            "hidden"
        );
    }

    hideOtherPreviews("image");
}


/* =========================================================
   LOAD IMAGE TO CANVAS
========================================================= */

async function loadImageToCanvas(file) {

    return new Promise(
        (resolve, reject) => {

            const img =
                new Image();

            const url =
                URL.createObjectURL(file);

            img.onload = () => {

                URL.revokeObjectURL(url);

                const maxDimension = 2200;

                const scale =
                    Math.min(
                        1,
                        maxDimension /
                        Math.max(
                            img.naturalWidth,
                            img.naturalHeight
                        )
                    );

                const canvas =
                    document.createElement(
                        "canvas"
                    );

                canvas.width =
                    Math.max(
                        1,
                        Math.round(
                            img.naturalWidth *
                            scale
                        )
                    );

                canvas.height =
                    Math.max(
                        1,
                        Math.round(
                            img.naturalHeight *
                            scale
                        )
                    );

                const ctx =
                    canvas.getContext(
                        "2d",
                        {
                            willReadFrequently:
                                true
                        }
                    );

                if (!ctx) {

                    reject(
                        new Error(
                            "Canvas is not supported."
                        )
                    );

                    return;
                }

                ctx.imageSmoothingEnabled =
                    true;

                ctx.imageSmoothingQuality =
                    "high";

                ctx.drawImage(
                    img,
                    0,
                    0,
                    canvas.width,
                    canvas.height
                );

                resolve({

                    canvas,

                    naturalWidth:
                        img.naturalWidth,

                    naturalHeight:
                        img.naturalHeight

                });
            };

            img.onerror = () => {

                URL.revokeObjectURL(url);

                reject(
                    new Error(
                        "Unable to load image."
                    )
                );
            };

            img.src = url;
        }
    );
}


/* =========================================================
   CLONE IMAGE DATA
========================================================= */

function cloneImageData(
    ctx,
    canvas
) {

    return ctx.getImageData(
        0,
        0,
        canvas.width,
        canvas.height
    );
}


/* =========================================================
   CANVAS TO BLOB
========================================================= */

function canvasToBlob(canvas) {

    return new Promise(
        (resolve, reject) => {

            canvas.toBlob(
                blob => {

                    if (!blob) {

                        reject(
                            new Error(
                                "Unable to preprocess image."
                            )
                        );

                        return;
                    }

                    resolve(blob);
                },
                "image/png"
            );
        }
    );
}


/* =========================================================
   GRAYSCALE + CONTRAST
========================================================= */

function applyGrayscaleContrast(
    data,
    contrast = 1.45,
    midpoint = 128
) {

    for (
        let i = 0;
        i < data.length;
        i += 4
    ) {

        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        let gray =
            (
                0.299 * r +
                0.587 * g +
                0.114 * b
            );

        gray =
            (
                gray -
                midpoint
            ) *
            contrast +
            midpoint;

        gray =
            Math.max(
                0,
                Math.min(
                    255,
                    gray
                )
            );

        data[i] =
            gray;

        data[i + 1] =
            gray;

        data[i + 2] =
            gray;
    }

    return data;
}


/* =========================================================
   THRESHOLD
========================================================= */

function applyThreshold(
    data,
    threshold = 150
) {

    for (
        let i = 0;
        i < data.length;
        i += 4
    ) {

        const gray =
            0.299 * data[i] +
            0.587 * data[i + 1] +
            0.114 * data[i + 2];

        const value =
            gray >= threshold
                ? 255
                : 0;

        data[i] =
            value;

        data[i + 1] =
            value;

        data[i + 2] =
            value;
    }

    return data;
}


/* =========================================================
   SHARPEN
========================================================= */

function applySharpen(
    imageData,
    canvas
) {

    const w = canvas.width;
    const h = canvas.height;

    const src =
        imageData.data;

    const out =
        new Uint8ClampedArray(
            src.length
        );

    const kernel = [
        0, -1, 0,
        -1, 5, -1,
        0, -1, 0
    ];

    for (
        let y = 0;
        y < h;
        y++
    ) {

        for (
            let x = 0;
            x < w;
            x++
        ) {

            const idx =
                (
                    y * w +
                    x
                ) * 4;

            if (
                x === 0 ||
                y === 0 ||
                x === w - 1 ||
                y === h - 1
            ) {

                out[idx] =
                    src[idx];

                out[idx + 1] =
                    src[idx + 1];

                out[idx + 2] =
                    src[idx + 2];

                out[idx + 3] =
                    src[idx + 3];

                continue;
            }

            let sum = 0;
            let k = 0;

            for (
                let ky = -1;
                ky <= 1;
                ky++
            ) {

                for (
                    let kx = -1;
                    kx <= 1;
                    kx++
                ) {

                    const nIdx =
                        (
                            (
                                y + ky
                            ) *
                            w +
                            (
                                x + kx
                            )
                        ) * 4;

                    sum +=
                        src[nIdx] *
                        kernel[k];

                    k++;
                }
            }

            const value =
                Math.max(
                    0,
                    Math.min(
                        255,
                        sum
                    )
                );

            out[idx] =
                value;

            out[idx + 1] =
                value;

            out[idx + 2] =
                value;

            out[idx + 3] =
                src[idx + 3];
        }
    }

    imageData.data.set(out);

    return imageData;
}


/* =========================================================
   BUILD OCR VARIANTS
========================================================= */

async function buildOcrVariants(file) {

    const {
        canvas,
        naturalWidth,
        naturalHeight
    } =
        await loadImageToCanvas(file);

    const ctx =
        canvas.getContext(
            "2d",
            {
                willReadFrequently:
                    true
            }
        );

    const variants = [];


    /* PASS 1 */

    {

        const data =
            cloneImageData(
                ctx,
                canvas
            );

        applyGrayscaleContrast(
            data.data,
            1.45,
            128
        );

        ctx.putImageData(
            data,
            0,
            0
        );

        variants.push({

            name: "contrast",

            blob:
                await canvasToBlob(
                    canvas
                )

        });
    }


    /* PASS 2 */

    {

        const data =
            cloneImageData(
                ctx,
                canvas
            );

        applyThreshold(
            data.data,
            150
        );

        ctx.putImageData(
            data,
            0,
            0
        );

        variants.push({

            name: "threshold",

            blob:
                await canvasToBlob(
                    canvas
                )

        });
    }


    /* PASS 3 */

    {

        const data =
            cloneImageData(
                ctx,
                canvas
            );

        applyGrayscaleContrast(
            data.data,
            1.2,
            128
        );

        applySharpen(
            data,
            canvas
        );

        ctx.putImageData(
            data,
            0,
            0
        );

        variants.push({

            name: "sharpened",

            blob:
                await canvasToBlob(
                    canvas
                )

        });
    }


    return {

        variants,

        naturalWidth,

        naturalHeight

    };
}


/* =========================================================
   PREPROCESS IMAGE
========================================================= */

async function preprocessImage(file) {

    const {
        variants
    } =
        await buildOcrVariants(file);

    return variants[0].blob;
}


/* =========================================================
   ASSESS IMAGE QUALITY
========================================================= */

async function assessImageQuality(file) {

    const warnings = [];

    try {

        const {
            canvas,
            naturalWidth,
            naturalHeight
        } =
            await loadImageToCanvas(file);

        if (
            naturalWidth < 300 ||
            naturalHeight < 150
        ) {

            warnings.push(
                "This image has a very low resolution. Try uploading a higher-resolution screenshot."
            );
        }

        const ctx =
            canvas.getContext(
                "2d",
                {
                    willReadFrequently:
                        true
                }
            );

        const sampleW =
            Math.min(
                200,
                canvas.width
            );

        const sampleH =
            Math.max(
                1,
                Math.round(
                    sampleW *
                    (
                        canvas.height /
                        canvas.width
                    )
                )
            );

        const sampleCanvas =
            document.createElement(
                "canvas"
            );

        sampleCanvas.width =
            sampleW;

        sampleCanvas.height =
            sampleH;

        const sampleCtx =
            sampleCanvas.getContext(
                "2d",
                {
                    willReadFrequently:
                        true
                }
            );

        sampleCtx.drawImage(
            canvas,
            0,
            0,
            sampleW,
            sampleH
        );

        const data =
            sampleCtx.getImageData(
                0,
                0,
                sampleW,
                sampleH
            ).data;

        let brightnessSum = 0;
        let gradientSum = 0;

        const gray =
            new Float32Array(
                sampleW *
                sampleH
            );

        for (
            let i = 0,
            p = 0;
            i < data.length;
            i += 4,
            p++
        ) {

            const g =
                0.299 * data[i] +
                0.587 * data[i + 1] +
                0.114 * data[i + 2];

            gray[p] = g;

            brightnessSum += g;
        }

        const avgBrightness =
            brightnessSum /
            gray.length;

        for (
            let y = 1;
            y < sampleH - 1;
            y++
        ) {

            for (
                let x = 1;
                x < sampleW - 1;
                x++
            ) {

                const idx =
                    y *
                    sampleW +
                    x;

                const gx =
                    gray[idx + 1] -
                    gray[idx - 1];

                const gy =
                    gray[idx + sampleW] -
                    gray[idx - sampleW];

                gradientSum +=
                    Math.abs(gx) +
                    Math.abs(gy);
            }
        }

        const sharpnessScore =
            gradientSum /
            (
                sampleW *
                sampleH
            );

        if (
            avgBrightness < 55
        ) {

            warnings.push(
                "This image looks very dark. OCR accuracy may be reduced."
            );

        } else if (
            avgBrightness > 225
        ) {

            warnings.push(
                "This image looks overexposed. OCR accuracy may be reduced."
            );
        }

        if (
            sharpnessScore < 6
        ) {

            warnings.push(
                "This image appears blurry or low in detail. OCR accuracy may be reduced."
            );
        }

        return {

            warnings,

            naturalWidth,

            naturalHeight

        };

    } catch (error) {

        console.error(
            "Image quality check failed:",
            error
        );

        return {

            warnings,

            naturalWidth: null,

            naturalHeight: null

        };
    }
}


/* =========================================================
   CLEAN OCR TEXT
========================================================= */

function cleanOCRText(text) {

    if (!text) {
        return "";
    }

    return String(text)

        .normalize("NFKC")

        .replace(
            /[\u0000-\u001F\u007F]/g,
            " "
        )

        .replace(
            /([A-Za-z])-\n([A-Za-z])/g,
            "$1$2"
        )

        .replace(
            /[ \t]+/g,
            " "
        )

        .replace(
            /\s+([,.!?;:])/g,
            "$1"
        )

        .replace(
            /\n[ \t]+/g,
            "\n"
        )

        .replace(
            /\n{3,}/g,
            "\n\n"
        )

        .replace(
            /([^\w\s])\1{3,}/g,
            "$1$1"
        )

        .trim();
}


/* =========================================================
   OCR QUALITY SCORING
========================================================= */

function computeOcrQuality(
    text,
    engineConfidence
) {

    const clean =
        String(text || "").trim();

    if (!clean) {

        return {

            score: 0,

            label: "Poor",

            reasons: [
                "No readable text was found."
            ]

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
            ) / total
            : 0;

    const weirdSymbols =
        (
            clean.match(
                /[^\w\s.,!?;:'"()\-%$@#&/]/g
            ) || []
        ).length;

    const weirdRatio =
        total > 0
            ? weirdSymbols / total
            : 0;

    const words =
        clean
            .split(/\s+/)
            .filter(Boolean);

    const dictionaryLikeWords =
        words.filter(
            w =>
                /^[A-Za-z][A-Za-z'-]{1,}$/.test(w)
        ).length;

    const wordValidityRatio =
        words.length > 0
            ? dictionaryLikeWords /
                words.length
            : 0;

    const excessiveSpacing =
        (
            clean.match(
                / {3,}/g
            ) || []
        ).length;

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
        confidence * 0.45 +
        alphaRatio * 100 * 0.25 +
        wordValidityRatio * 100 * 0.20 +
        Math.max(
            0,
            1 - weirdRatio * 4
        ) * 100 * 0.10;

    if (total < 8) {
        score -= 15;
    }

    if (excessiveSpacing > 3) {
        score -= 5;
    }

    score =
        Math.max(
            0,
            Math.min(
                100,
                Math.round(score)
            )
        );

    let label = "Poor";

    if (score >= 85) {
        label = "Excellent";
    }

    else if (score >= 70) {
        label = "Good";
    }

    else if (score >= 45) {
        label = "Fair";
    }

    const reasons = [];

    if (alphaRatio < 0.6) {

        reasons.push(
            "Many non-letter/number characters were detected."
        );
    }

    if (
        wordValidityRatio < 0.5 &&
        words.length > 3
    ) {

        reasons.push(
            "Several extracted words don't look like real words."
        );
    }

    if (weirdRatio > 0.1) {

        reasons.push(
            "Unusual symbols were found in the extracted text."
        );
    }

    return {

        score,

        label,

        reasons

    };
}


/* =========================================================
   OCR QUALITY UI
========================================================= */

function updateOcrQualityUI(quality) {

    const row =
        $("ocrQualityRow");

    const badge =
        $("ocrQualityBadge");

    const warningBanner =
        $("ocrWarningBanner");

    const warningText =
        $("ocrWarningText");

    if (row && badge) {

        row.classList.remove(
            "hidden"
        );

        badge.className =
            `ocr-quality-badge ${quality.label.toLowerCase()}`;

        badge.textContent =
            `OCR Quality: ${quality.score}% — ${quality.label}`;
    }

    if (
        warningBanner &&
        warningText
    ) {

        if (quality.score < 45) {

            warningText.textContent =
                "⚠ OCR quality is low. The extracted text may contain errors. Try uploading a clearer image.";

            warningBanner.classList.remove(
                "hidden"
            );

        } else {

            warningBanner.classList.add(
                "hidden"
            );
        }
    }
}


/* =========================================================
   OCR REVIEW CARD
========================================================= */

function showOcrReviewCard(
    rawText,
    cleanedText
) {

    const card =
        $("ocrReviewCard");

    const textarea =
        $("ocrReviewText");

    lastOcrRaw =
        rawText;

    lastOcrClean =
        cleanedText;

    if (card) {

        card.classList.remove(
            "hidden"
        );
    }

    if (textarea) {

        textarea.value =
            cleanedText;
    }
}


function hideOcrReviewCard() {

    $("ocrReviewCard")
        ?.classList.add(
            "hidden"
        );

    $("ocrQualityRow")
        ?.classList.add(
            "hidden"
        );

    $("ocrWarningBanner")
        ?.classList.add(
            "hidden"
        );

    $("imageMeta")
        ?.classList.add(
            "hidden"
        );

    lastOcrRaw = "";
    lastOcrClean = "";
    lastOcrQuality = null;
    lastOcrSourceKind = null;
}


/* =========================================================
   COPY OCR TEXT
========================================================= */

function copyOcrText() {

    const textarea =
        $("ocrReviewText");

    const text =
        textarea
            ? textarea.value
            : lastOcrClean;

    if (!text) {

        showToast(
            "There's no extracted text to copy yet.",
            "warning"
        );

        return;
    }

    navigator.clipboard
        ?.writeText(text)
        .then(
            () =>
                showToast("Copied!")
        )
        .catch(
            () =>
                showToast(
                    "Unable to copy text.",
                    "error"
                )
        );
}


/* =========================================================
   USE EXTRACTED TEXT
========================================================= */

function useExtractedText() {

    const textarea =
        $("ocrReviewText");

    const input =
        $("newsInput");

    if (!textarea || !input) {
        return;
    }

    input.value =
        textarea.value;

    updateCharacterCount();
    updateWordCount();

    showToast(
        "Extracted text applied to the input box."
    );
}


/* =========================================================
   ANALYZE CORRECTED OCR TEXT
========================================================= */

async function analyzeCorrectedText() {

    const textarea =
        $("ocrReviewText");

    if (
        !textarea ||
        !textarea.value.trim()
    ) {

        showToast(
            "Add some text before analyzing.",
            "warning"
        );

        return;
    }

    const input =
        $("newsInput");

    if (input) {

        input.value =
            textarea.value;

        updateCharacterCount();
        updateWordCount();
    }

    await analyzeTextInput(
        textarea.value.trim(),
        {
            ocrQuality:
                lastOcrQuality
        }
    );
}


/* =========================================================
   MULTI-PASS OCR
========================================================= */

async function runOCR(
    file,
    source = "photo"
) {

    if (!file) {

        throw new Error(
            "No image file provided."
        );
    }

    if (
        typeof Tesseract ===
        "undefined"
    ) {

        throw new Error(
            "Tesseract.js is not loaded."
        );
    }

    const newsInput =
        $("newsInput");

    showImagePreview(file);

    hideOcrReviewCard();

    setStatus(
        source === "camera"
            ? "Processing captured image..."
            : "Preparing image...",
        true
    );


    try {

        /* IMAGE QUALITY */

        setStatus(
            "Checking image quality...",
            true
        );

        const {
            warnings,
            naturalWidth,
            naturalHeight
        } =
            await assessImageQuality(
                file
            );

        updateImageMeta(
            file,
            naturalWidth,
            naturalHeight
        );

        if (warnings.length > 0) {

            showToast(
                warnings[0],
                "warning"
            );
        }


        /* PREPROCESS */

        setStatus(
            "Enhancing image...",
            true
        );

        const {
            variants
        } =
            await buildOcrVariants(
                file
            );


        /* OCR */

        let best = null;

        for (
            let i = 0;
            i < variants.length;
            i++
        ) {

            const variant =
                variants[i];

            setStatus(
                `Reading text... (pass ${i + 1} of ${variants.length})`,
                true
            );

            let result;

            try {

                result =
                    await Tesseract.recognize(
                        variant.blob,
                        "eng",
                        {

                            logger:
                                info => {

                                    if (
                                        info.status ===
                                        "recognizing text"
                                    ) {

                                        const progress =
                                            Math.round(
                                                (
                                                    info.progress ||
                                                    0
                                                ) * 100
                                            );

                                        setStatus(
                                            `Reading text... (pass ${i + 1} of ${variants.length}) ${progress}%`,
                                            true
                                        );
                                    }
                                }
                        }
                    );

            } catch (passError) {

                console.error(
                    `OCR pass "${variant.name}" failed:`,
                    passError
                );

                continue;
            }

            const rawText =
                result?.data?.text ||
                "";

            const cleanedText =
                cleanOCRText(
                    rawText
                );

            const engineConfidence =
                Number.isFinite(
                    result?.data?.confidence
                )
                    ? result.data.confidence
                    : null;

            const quality =
                computeOcrQuality(
                    cleanedText,
                    engineConfidence
                );

            if (
                !best ||
                quality.score >
                    best.quality.score
            ) {

                best = {

                    rawText,

                    cleanedText,

                    quality,

                    variant:
                        variant.name

                };
            }

            if (
                quality.score >= 90
            ) {

                break;
            }
        }


        setStatus(
            "Checking OCR quality...",
            true
        );


        if (
            !best ||
            !best.cleanedText ||
            best.cleanedText.length < 2
        ) {

            setStatus(
                "Unable to read text from this image. Try using a clearer or brighter photo.",
                true
            );

            showToast(
                "No readable text found.",
                "warning"
            );

            return;
        }


        console.log(
            `Best OCR pass: ${best.variant} (quality ${best.quality.score})`
        );


        /* OCR REVIEW */

        lastOcrSourceKind =
            source;

        lastOcrQuality =
            best.quality.score;

        showOcrReviewCard(
            best.rawText,
            best.cleanedText
        );

        updateOcrQualityUI(
            best.quality
        );


        if (newsInput) {

            newsInput.value =
                best.cleanedText;

            updateCharacterCount();
            updateWordCount();
        }


        setStatus(
            "Analyzing credibility...",
            true
        );


        /*
         * Tesseract already extracted the text.
         * We don't send the image again.
         */

        uploadedFile = null;
        uploadedFileKind = null;


        await analyzeTextInput(
            best.cleanedText,
            {
                ocrQuality:
                    best.quality.score
            }
        );


        showToast(
            best.quality.score < 45
                ? "Text extracted, but OCR quality is low — please review it."
                : "Image text analyzed successfully."
        );

    } catch (error) {

        console.error(
            "OCR ERROR:",
            error
        );

        setStatus(
            "Unable to read text from this image. Try using a clearer or brighter photo.",
            true
        );

        throw error;
    }
}


/* =========================================================
   VIDEO PICKER
========================================================= */

function openVideoPicker() {

    closeUploadMenu();

    const video =
        $("video");

    if (!video) {

        showToast(
            "Video picker is unavailable.",
            "error"
        );

        return;
    }

    video.click();
}


/* =========================================================
   VIDEO SETUP
========================================================= */

function setupVideo() {

    const videoInput =
        $("video");

    const previewVideo =
        $("previewVideo");

    const videoContainer =
        $("videoContainer");

    if (!videoInput) {
        return;
    }

    videoInput.addEventListener(
        "change",
        function () {

            const file =
                this.files?.[0];

            if (!file) {
                return;
            }

            if (
                !file.type.startsWith(
                    "video/"
                )
            ) {

                showToast(
                    "Please select a valid video file.",
                    "error"
                );

                this.value = "";

                return;
            }

            uploadedFile =
                file;

            uploadedFileKind =
                "video";

            if (
                currentVideoObjectURL
            ) {

                URL.revokeObjectURL(
                    currentVideoObjectURL
                );
            }

            currentVideoObjectURL =
                URL.createObjectURL(
                    file
                );

            if (previewVideo) {

                previewVideo.src =
                    currentVideoObjectURL;

                previewVideo.load();
            }

            if (videoContainer) {

                videoContainer.classList.remove(
                    "hidden"
                );
            }

            hideOtherPreviews("video");

            closeUploadMenu();

            showToast(
                "Video ready. Tap Analyze Content."
            );

            this.value = "";
        }
    );
}


/* =========================================================
   VIDEO PROGRESS
========================================================= */

function showVideoProgress(
    percent,
    text
) {

    const area =
        $("videoProgress");

    const bar =
        $("videoProgressBar");

    const label =
        $("videoProgressText");

    const number =
        $("videoProgressPercent");

    if (area) {

        area.classList.remove(
            "hidden"
        );
    }

    const value =
        Math.max(
            0,
            Math.min(
                100,
                Number(percent) || 0
            )
        );

    if (bar) {

        bar.style.width =
            `${value}%`;
    }

    if (label) {

        label.textContent =
            text ||
            "Scanning video...";
    }

    if (number) {

        number.textContent =
            `${Math.round(value)}%`;
    }
}


function hideVideoProgress() {

    const area =
        $("videoProgress");

    if (area) {

        area.classList.add(
            "hidden"
        );
    }
}


/* =========================================================
   FILE PICKER
========================================================= */

function openFilePicker() {

    closeUploadMenu();

    const file =
        $("file");

    if (!file) {

        showToast(
            "File picker is unavailable.",
            "error"
        );

        return;
    }

    file.click();
}


/* =========================================================
   FILE SETUP
========================================================= */

function setupFile() {

    const fileInput =
        $("file");

    const fileNamePreview =
        $("fileNamePreview");

    const fileTypePreview =
        $("fileTypePreview");

    const fileContainer =
        $("fileContainer");

    if (!fileInput) {
        return;
    }

    fileInput.addEventListener(
        "change",
        function () {

            const file =
                this.files?.[0];

            if (!file) {
                return;
            }

            const extension =
                file.name
                    .split(".")
                    .pop()
                    ?.toLowerCase();

            const supported = [
                "pdf",
                "docx",
                "txt"
            ];

            if (
                !supported.includes(
                    extension
                )
            ) {

                showToast(
                    "Unsupported file. Use PDF, DOCX, or TXT.",
                    "error"
                );

                this.value = "";

                return;
            }

            uploadedFile =
                file;

            uploadedFileKind =
                "file";

            if (fileNamePreview) {

                fileNamePreview.textContent =
                    file.name;
            }

            if (fileTypePreview) {

                fileTypePreview.textContent =
                    `${extension.toUpperCase()} • ${(file.size / 1024).toFixed(1)} KB`;
            }

            if (fileContainer) {

                fileContainer.classList.remove(
                    "hidden"
                );
            }

            hideOtherPreviews("file");

            closeUploadMenu();

            showToast(
                "File ready. Tap Analyze Content."
            );

            this.value = "";
        }
    );
}


/* =========================================================
   HIDE OTHER PREVIEWS
========================================================= */

function hideOtherPreviews(current) {

    const image =
        $("imageContainer");

    const video =
        $("videoContainer");

    const file =
        $("fileContainer");

    if (current !== "image") {

        image?.classList.add(
            "hidden"
        );
    }

    if (current !== "video") {

        video?.classList.add(
            "hidden"
        );
    }

    if (current !== "file") {

        file?.classList.add(
            "hidden"
        );
    }
}


/* =========================================================
   REMOVE CURRENT MEDIA
========================================================= */

function removeCurrentMedia() {

    uploadedFile = null;

    uploadedFileKind = null;


    if (currentPreviewObjectURL) {

        URL.revokeObjectURL(
            currentPreviewObjectURL
        );

        currentPreviewObjectURL = null;
    }


    if (currentVideoObjectURL) {

        URL.revokeObjectURL(
            currentVideoObjectURL
        );

        currentVideoObjectURL = null;
    }


    const previewImage =
        $("previewImage");

    const previewVideo =
        $("previewVideo");


    if (previewImage) {

        previewImage.removeAttribute(
            "src"
        );
    }


    if (previewVideo) {

        previewVideo.pause();

        previewVideo.removeAttribute(
            "src"
        );

        previewVideo.load();
    }


    [
        "imageContainer",
        "videoContainer",
        "fileContainer"
    ].forEach(
        id => {

            $(id)?.classList.add(
                "hidden"
            );

        }
    );


    hideOcrReviewCard();


    showToast(
        "Content removed."
    );
}


/* =========================================================
   IMAGE HIGHLIGHT BOXES
========================================================= */

function drawHighlightBoxes(words) {

    if (
        !Array.isArray(words) ||
        words.length === 0
    ) {
        return;
    }

    const previewImage =
        $("previewImage");

    const canvas =
        $("highlightCanvas");

    if (
        !previewImage ||
        !canvas
    ) {
        return;
    }

    function draw() {

        if (!previewImage.naturalWidth) {
            return;
        }

        canvas.width =
            previewImage.naturalWidth;

        canvas.height =
            previewImage.naturalHeight;

        const ctx =
            canvas.getContext("2d");

        if (!ctx) {
            return;
        }

        ctx.clearRect(
            0,
            0,
            canvas.width,
            canvas.height
        );

        ctx.lineWidth =
            Math.max(
                3,
                canvas.width / 400
            );

        ctx.strokeStyle =
            "#dc2626";

        words.forEach(word => {

            const box =
                word.bbox;

            if (!box) {
                return;
            }

            const x0 =
                Number(box.x0);

            const y0 =
                Number(box.y0);

            const x1 =
                Number(box.x1);

            const y1 =
                Number(box.y1);

            if (
                ![
                    x0,
                    y0,
                    x1,
                    y1
                ].every(
                    Number.isFinite
                )
            ) {
                return;
            }

            ctx.strokeRect(
                x0,
                y0,
                Math.max(
                    1,
                    x1 - x0
                ),
                Math.max(
                    1,
                    y1 - y0
                )
            );
        });
    }

    if (previewImage.complete) {

        draw();

    } else {

        previewImage.onload =
            draw;
    }
}


/* =========================================================
   SIDEBAR
========================================================= */

function toggleSidebar() {

    const sidebar =
        $("sidebar");

    const overlay =
        $("sidebarOverlay");

    if (!sidebar || !overlay) {
        return;
    }

    const open =
        sidebar.classList.contains(
            "open"
        );

    if (open) {

        closeSidebar();

    } else {

        sidebar.classList.add(
            "open"
        );

        overlay.classList.remove(
            "hidden"
        );
    }
}


function closeSidebar() {

    $("sidebar")
        ?.classList.remove(
            "open"
        );

    $("sidebarOverlay")
        ?.classList.add(
            "hidden"
        );
}


/* =========================================================
   HOME
========================================================= */

function goHome() {

    closeSidebar();

    closePanels();

    closeUploadMenu();

    closeCamera();

    removeCurrentMedia();


    const input =
        $("newsInput");

    if (input) {

        input.value = "";

        updateCharacterCount();

        updateWordCount();
    }


    [
        "result",
        "highlightedContainer"
    ].forEach(
        id => {

            $(id)?.classList.add(
                "hidden"
            );

        }
    );


    setStatus(
        "",
        false
    );


    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}


/* =========================================================
   HISTORY
========================================================= */

function getHistory() {

    try {

        return JSON.parse(
            localStorage.getItem(
                "reviewwiseHistory"
            ) || "[]"
        );

    } catch {

        return [];
    }
}


function openHistory() {

    closeSidebar();

    const panel =
        $("historyPanel");

    const container =
        $("historyList");

    if (
        !panel ||
        !container
    ) {
        return;
    }

    renderHistory();

    panel.classList.remove(
        "hidden"
    );

    requestAnimationFrame(
        () => {

            panel.classList.add(
                "open"
            );

        }
    );
}


function renderHistory() {

    const container =
        $("historyList");

    if (!container) {
        return;
    }

    const list =
        getHistory();

    if (list.length === 0) {

        container.innerHTML = `

            <div class="empty-history">

                <div class="empty-history-icon"></div>

                <strong>
                    No checks yet
                </strong>

                <p>
                    Your history will appear here.
                </p>

            </div>

        `;

        return;
    }


    container.innerHTML =
        list
            .map(
                item => {

                    const score =
                        Number(
                            item.credibility
                        ) || 0;

                    const level =
                        getScoreLevel(
                            score
                        );

                    return `

                        <div
                            class="history-item"
                            data-history-id="${escapeHtml(item.id || "")}">

                            <div class="history-top">

                                <span class="history-type">
                                    ${escapeHtml(
                                        String(
                                            item.contentType ||
                                            "text"
                                        ).toUpperCase()
                                    )}
                                </span>

                                <span
                                    class="history-score"
                                    style="color:${getScoreColor(score)}">

                                    ${score}/100

                                </span>

                            </div>

                            <div
                                class="history-status"
                                style="color:${getScoreColor(score)}">

                                ${escapeHtml(
                                    level.label
                                )}

                            </div>

                            <div class="history-preview">

                                ${escapeHtml(
                                    item.snippet ||
                                    ""
                                )}

                                ${
                                    (
                                        item.snippet ||
                                        ""
                                    ).length >= 100
                                        ? "..."
                                        : ""
                                }

                            </div>

                            <div class="history-time">

                                ${escapeHtml(
                                    item.time ||
                                    ""
                                )}

                            </div>

                            <div class="history-actions">

                                <button
                                    class="history-open"
                                    onclick="openHistoryItem('${escapeHtml(item.id || "")}')">

                                    Open Result

                                </button>

                                <button
                                    class="history-delete"
                                    onclick="deleteHistoryItem('${escapeHtml(item.id || "")}')">

                                    Delete

                                </button>

                            </div>

                        </div>

                    `;
                }
            )
            .join("");
}


function openHistoryItem(id) {

    const list =
        getHistory();

    const item =
        list.find(
            entry =>
                entry.id === id
        );

    if (!item) {

        showToast(
            "History item could not be found.",
            "error"
        );

        return;
    }

    closePanels();

    const input =
        $("newsInput");

    if (input) {

        input.value =
            item.text || "";

        updateCharacterCount();

        updateWordCount();
    }

    uploadedFile = null;

    uploadedFileKind = null;

    renderAnalysis(
        item.analysis || {

            text:
                item.text,

            credibility:
                item.credibility,

            status:
                item.status,

            highlightedWords:
                []

        }
    );

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}


function deleteHistoryItem(id) {

    let list =
        getHistory();

    list =
        list.filter(
            item =>
                item.id !== id
        );

    localStorage.setItem(
        "reviewwiseHistory",
        JSON.stringify(list)
    );

    renderHistory();

    showToast(
        "History item deleted."
    );
}


/* =========================================================
   ABOUT
========================================================= */

function openAbout() {

    closeSidebar();

    const panel =
        $("aboutPanel");

    if (!panel) {
        return;
    }

    panel.classList.remove(
        "hidden"
    );

    requestAnimationFrame(
        () => {

            panel.classList.add(
                "open"
            );

        }
    );
}


/* =========================================================
   HOW TO USE (ONBOARDING)
========================================================= */

function openHowToUse() {

    closeSidebar();

    const screen =
        $("howToUseScreen");

    if (!screen) {
        return;
    }

    screen.classList.remove(
        "hidden"
    );

    requestAnimationFrame(
        () => {

            screen.classList.remove(
                "hide"
            );

        }
    );
}


function continueToApp() {

    const screen =
        $("howToUseScreen");

    if (screen) {

        screen.classList.add(
            "hide"
        );

        setTimeout(
            () => {

                screen.classList.add(
                    "hidden"
                );

            },
            300
        );
    }

    try {

        localStorage.setItem(
            HOW_TO_USE_SEEN_KEY,
            "1"
        );

    } catch {

        /* localStorage unavailable — ignore */
    }

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });
}


/* =========================================================
   CLOSE PANELS
========================================================= */

function closePanels() {

    const history =
        $("historyPanel");

    const about =
        $("aboutPanel");

    history?.classList.remove(
        "open"
    );

    about?.classList.remove(
        "open"
    );

    setTimeout(
        () => {

            history?.classList.add(
                "hidden"
            );

            about?.classList.add(
                "hidden"
            );

        },
        300
    );
}


/* =========================================================
   CLEAR HISTORY
========================================================= */

function clearHistory() {

    const confirmed =
        window.confirm(
            "Clear all ReviewWise history?"
        );

    if (!confirmed) {
        return;
    }

    localStorage.removeItem(
        "reviewwiseHistory"
    );

    closeSidebar();

    renderHistory();

    showToast(
        "History cleared."
    );
}


/* =========================================================
   CLOSE MENU OUTSIDE
========================================================= */

document.addEventListener(
    "click",
    event => {

        const menu =
            $("menu");

        const plus =
            $("plusButton");

        if (!menu || !plus) {
            return;
        }

        if (
            menu.classList.contains("open") &&
            !menu.contains(event.target) &&
            !plus.contains(event.target)
        ) {

            closeUploadMenu();
        }
    }
);


/* =========================================================
   ESC KEY
========================================================= */

document.addEventListener(
    "keydown",
    event => {

        if (
            event.key === "Escape"
        ) {

            closeUploadMenu();

            closePanels();

            closeCamera();
        }
    }
);


/* =========================================================
   CLEANUP
========================================================= */

window.addEventListener(
    "beforeunload",
    () => {

        stopCameraStream();

        if (
            currentPreviewObjectURL
        ) {

            URL.revokeObjectURL(
                currentPreviewObjectURL
            );
        }

        if (
            currentVideoObjectURL
        ) {

            URL.revokeObjectURL(
                currentVideoObjectURL
            );
        }
    }
);


/* =========================================================
   INITIALIZATION
========================================================= */

function initializeReviewWise() {

    console.log(
        "🚀 Initializing ReviewWise..."
    );

    setupPhoto();

    setupVideo();

    setupFile();

    setupDragAndDrop();


    const input =
        $("newsInput");

    if (input) {

        input.addEventListener(
            "input",
            () => {

                updateCharacterCount();

                updateWordCount();

            }
        );

        updateCharacterCount();

        updateWordCount();
    }


    /* LOADING SCREEN */

    const loading =
        $("loadingScreen");

    setTimeout(
        () => {

            loading?.classList.add(
                "hide"
            );

            /* Show the "How to Use" guide before the
               main page on a person's first visit. */

            let hasSeenHowToUse = false;

            try {

                hasSeenHowToUse =
                    localStorage.getItem(
                        HOW_TO_USE_SEEN_KEY
                    ) === "1";

            } catch {

                hasSeenHowToUse = false;
            }

            if (!hasSeenHowToUse) {

                openHowToUse();

            }

        },
        1200
    );


    console.log(
        "✅ ReviewWise initialized."
    );
}


/* =========================================================
   DOM READY
========================================================= */

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        initializeReviewWise
    );

} else {

    initializeReviewWise();

}

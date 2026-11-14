"use strict";

/* =========================================================
   REVIEWWISE CONFIGURATION
========================================================= */

const API_BASE = (window.REVIEWWISE_CONFIG && window.REVIEWWISE_CONFIG.apiBase) || ((location.hostname === "localhost" || location.hostname === "127.0.0.1") ? "" : "https://reviewwise.onrender.com");

const REQUEST_TIMEOUT_MS = 45000;
const MAX_HISTORY_ITEMS = 50;
const HOW_TO_USE_SEEN_KEY = "reviewwiseSeenHowToUse";

let uploadedFile = null;
let uploadedFileKind = null;

let cameraStream = null;
let capturedCameraBlob = null;
let currentPreviewObjectURL = null;

let isProcessing = false;

/* Speech-to-text state */
let speechRecognition = null;
let isListening = false;

/* Most recent OCR result */
let lastOcrRaw = "";
let lastOcrClean = "";
let lastOcrQuality = null;
let lastOcrSourceKind = null;

/* Shared Tesseract worker (loaded once, reused for every pass) */
let ocrWorkerPromise = null;
let ocrProgressHandler = null;

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
   FOOTER YEAR
========================================================= */

function updateFooterYear() {

    const yearEl =
        $("footerYear");

    if (!yearEl) {
        return;
    }

    yearEl.textContent =
        new Date().getFullYear();
}


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

            c

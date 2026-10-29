import DOMPurify from "dompurify";

const htmlTagPattern = /<\/?(div|p|br|strong|b|span|mark|ul|ol|li|font|table|tbody|thead|tfoot|tr|td|th)\b/i;
const richTextTags = ["br", "strong", "b", "span", "mark", "div"];
const richTextAttributes = ["class", "contenteditable"];

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: "\u00a0",
    quot: '"',
  };

  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, reference) => {
    const name = reference.toLowerCase();
    if (name in namedEntities) return namedEntities[name];
    if (!name.startsWith("#")) return entity;

    const codePoint = name.startsWith("#x")
      ? Number.parseInt(name.slice(2), 16)
      : Number.parseInt(name.slice(1), 10);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function normalizeWhitespace(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").trim();
}

export function plainTextToHtml(value: string) {
  return normalizeWhitespace(value)
    .split(/\r?\n/)
    .map((line) => (line ? escapeHtml(line) : "<br>"))
    .join("<br>");
}

function tableHtmlToText(html: string) {
  const tableText = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/(?:tr|p|div|li)\s*>/gi, "\n")
    .replace(/<\s*\/(?:th|td)\s*>/gi, "\t");
  const text = DOMPurify.sanitize(tableText, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
  return normalizeWhitespace(decodeHtmlEntities(text).replace(/[ \t]+\t/g, "\t"));
}

export function sanitizeRichHtml(html: string) {
  if (/google-sheets-html-origin|<table\b/i.test(html)) {
    return plainTextToHtml(tableHtmlToText(html));
  }

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: richTextTags,
    ALLOWED_ATTR: richTextAttributes,
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ["style"],
  }).trim();
}

export function sanitizeClipboardHtml(html: string, fallbackText = "") {
  const sanitized = sanitizeRichHtml(html);
  return sanitized || plainTextToHtml(fallbackText);
}

export function normalizeStoredRichText(content: string) {
  if (!content) return "";

  const decoded = /&lt;|&gt;|&amp;/.test(content) ? decodeHtmlEntities(content) : content;
  if (decoded !== content && /google-sheets-html-origin|<table\b/i.test(decoded)) {
    return plainTextToHtml(tableHtmlToText(decoded));
  }
  if (/google-sheets-html-origin|<table\b/i.test(content)) {
    return plainTextToHtml(tableHtmlToText(content));
  }
  if (decoded !== content && htmlTagPattern.test(decoded)) {
    return sanitizeRichHtml(decoded);
  }
  if (htmlTagPattern.test(content)) {
    return sanitizeRichHtml(content);
  }

  return plainTextToHtml(content)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/==(.*?)==/g, "<mark>$1</mark>")
    .replace(/- \[ \] ?/g, '<span class="todo-check" contenteditable="false"></span> ');
}

export function insertHtmlAtSelection(editor: HTMLElement, html: string) {
  editor.focus();
  const selection = window.getSelection();
  if (!selection) return;

  let range: Range;
  if (selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
    range = selection.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }

  range.deleteContents();
  const template = document.createElement("template");
  template.innerHTML = sanitizeRichHtml(html);
  const fragment = template.content;
  const lastNode = fragment.lastChild;
  range.insertNode(fragment);

  if (lastNode) {
    range = document.createRange();
    range.setStartAfter(lastNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

export function insertSanitizedDrop(editor: HTMLElement, transfer: DataTransfer, x: number, y: number) {
  const html = transfer.getData("text/html");
  const text = transfer.getData("text/plain");
  if (!html && !text) return false;

  const range = document.caretRangeFromPoint(x, y);
  if (range && editor.contains(range.commonAncestorContainer)) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  insertHtmlAtSelection(editor, sanitizeClipboardHtml(html, text));
  return true;
}

const MARKDOWN_HEADING_PATTERN = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/;

function normalizeLineEndings(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function normalizeHeadingLabel(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function trimBoundaryBlankLines(lines = []) {
  let start = 0;
  let end = lines.length;

  while (start < end && !String(lines[start] || "").trim()) {
    start += 1;
  }
  while (end > start && !String(lines[end - 1] || "").trim()) {
    end -= 1;
  }

  return lines.slice(start, end);
}

function parseMarkdownHeadings(content = "") {
  const lines = normalizeLineEndings(content).split("\n");
  const headings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(MARKDOWN_HEADING_PATTERN);
    if (!match) {
      continue;
    }
    headings.push({
      index,
      line: index + 1,
      level: match[1].length,
      raw: lines[index],
      title: match[2].trim(),
      normalized_title: normalizeHeadingLabel(match[2]),
    });
  }

  return headings;
}

function resolveTargetPosition(position = "") {
  const normalized = String(position || "").trim().toLowerCase();
  if (!normalized || normalized === "end_of_section" || normalized === "section_end") {
    return "end_of_section";
  }
  if (normalized === "after_heading") {
    return "after_heading";
  }
  throw new DocumentTargetingError(
    "unsupported_target_position",
    "Only end_of_section and after_heading are currently supported for heading targeting.",
    { target_position: position || null },
  );
}

function buildMergedDocument(beforeLines = [], insertLines = [], afterLines = []) {
  const merged = [];
  const normalizedBefore = trimBoundaryBlankLines(beforeLines);
  const normalizedInsert = trimBoundaryBlankLines(insertLines);
  const normalizedAfter = trimBoundaryBlankLines(afterLines);

  if (normalizedBefore.length) {
    merged.push(...normalizedBefore);
  }
  if (normalizedBefore.length && normalizedInsert.length) {
    merged.push("");
  }
  if (normalizedInsert.length) {
    merged.push(...normalizedInsert);
  }
  if ((normalizedBefore.length || normalizedInsert.length) && normalizedAfter.length) {
    merged.push("");
  }
  if (normalizedAfter.length) {
    merged.push(...normalizedAfter);
  }

  return merged.join("\n").trim();
}

function findHeadingMatches(headings = [], heading = "") {
  const normalizedHeading = normalizeHeadingLabel(heading);
  return headings.filter((item) => item.normalized_title === normalizedHeading);
}

function resolveSectionBoundary(headings = [], matchedHeading, lines = [], position = "end_of_section") {
  if (position === "after_heading") {
    return matchedHeading.index + 1;
  }

  for (const candidate of headings) {
    if (candidate.index <= matchedHeading.index) {
      continue;
    }
    if (candidate.level <= matchedHeading.level) {
      return candidate.index;
    }
  }

  return lines.length;
}

export class DocumentTargetingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DocumentTargetingError";
    this.code = code || "document_targeting_error";
    this.details = details && typeof details === "object" ? details : {};
  }
}

export function applyHeadingTargetedInsert(documentContent, insertContent, { heading = "", position = "" } = {}) {
  const requestedHeading = String(heading || "").trim();
  if (!requestedHeading) {
    throw new DocumentTargetingError(
      "missing_target_heading",
      "Heading targeting requires target_heading or target.section.",
    );
  }

  const normalizedDocument = normalizeLineEndings(documentContent);
  const normalizedInsert = normalizeLineEndings(insertContent);
  const headings = parseMarkdownHeadings(normalizedDocument);
  const matches = findHeadingMatches(headings, requestedHeading);

  if (!matches.length) {
    throw new DocumentTargetingError(
      "target_heading_not_found",
      `Could not find heading "${requestedHeading}" in the document.`,
      { target_heading: requestedHeading },
    );
  }

  if (matches.length > 1) {
    throw new DocumentTargetingError(
      "target_heading_ambiguous",
      `Heading "${requestedHeading}" matched more than one section. Use a unique heading first.`,
      {
        target_heading: requestedHeading,
        matches: matches.map((item) => ({
          line: item.line,
          level: item.level,
          raw: item.raw,
        })),
      },
    );
  }

  const resolvedPosition = resolveTargetPosition(position);
  const matchedHeading = matches[0];
  const lines = normalizedDocument.split("\n");
  const insertLines = trimBoundaryBlankLines(normalizedInsert.split("\n"));
  const insertIndex = resolveSectionBoundary(headings, matchedHeading, lines, resolvedPosition);
  const proposedContent = buildMergedDocument(
    lines.slice(0, insertIndex),
    insertLines,
    lines.slice(insertIndex),
  );

  return {
    content: proposedContent,
    targeting: {
      type: "heading",
      heading: requestedHeading,
      position: resolvedPosition,
      matched_heading: matchedHeading.title,
      matched_heading_line: matchedHeading.line,
      matched_heading_level: matchedHeading.level,
      resolved_write_mode: "replace",
    },
  };
}

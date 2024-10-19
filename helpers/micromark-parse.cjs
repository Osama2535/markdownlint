// @ts-check

"use strict";

// const micromark = require("markdownlint-micromark");
const micromark = require("../micromark/micromark.cjs");
const { isHtmlFlowComment } = require("./micromark-helpers.cjs");
const { flatTokensSymbol, htmlFlowSymbol, newLineRe } = require("./shared.js");

/** @typedef {import("markdownlint-micromark").Event} Event */
/** @typedef {import("markdownlint-micromark").ParseOptions} MicromarkParseOptions */
/** @typedef {import("markdownlint-micromark").Token} Token */
/** @typedef {import("../lib/markdownlint.js").MicromarkToken} MicromarkToken */

/**
 * Parse options.
 *
 * @typedef {Object} ParseOptions
 * @property {boolean} [freezeTokens] Whether to freeze output Tokens.
 * @property {boolean} [shimReferences] Whether to shim missing references.
 */

/**
 * Parses a Markdown document and returns Micromark events.
 *
 * @param {string} markdown Markdown document.
 * @param {ParseOptions} [parseOptions] Options.
 * @param {MicromarkParseOptions} [micromarkParseOptions] Options for micromark.
 * @returns {Event[]} Micromark events.
 */
function getEvents(
  markdown,
  parseOptions = {},
  micromarkParseOptions = {}
) {
  // Get options
  const shimReferences = Boolean(parseOptions.shimReferences);

  // Customize options object to add useful extensions
  micromarkParseOptions.extensions = micromarkParseOptions.extensions || [];
  micromarkParseOptions.extensions.push(
    micromark.directive(),
    micromark.gfmAutolinkLiteral(),
    micromark.gfmFootnote(),
    micromark.gfmTable(),
    micromark.math()
  );

  // // Shim labelEnd to identify undefined link labels
  /** @type {Event[][]} */
  const artificialEventLists = [];
  const { labelEnd } = micromark;
  const tokenizeOriginal = labelEnd.tokenize;
  function tokenizeShim(effects, okOriginal, nokOriginal) {
    // TODO: Type this as TokenizeContext
    const tokenizeContext = this;
    const nokShim = (code) => {
      // TODO: Remove next
      /** @type {Event[]} */
      const events = tokenizeContext.events;

      // Find start of label
      let indexStart = events.length;
      while (--indexStart >= 0) {
        const event = events[indexStart];
        const [ kind, token ] = event;
        if (kind === "enter") {
          const { type, _balanced } = token;
          if ((type === "labelImage") || (type === "labelLink")) {
            break;
          }
        }
      }

      if (indexStart >= 0) {
        // Create artificial enter/exit and all "data" events within
        const eventStart = events[indexStart];
        const eventEnd = events[events.length - 1];
        /** @type {Token} */
        const artificialToken = {
          "type": "undefinedReferenceShortcut",
          "start": eventStart[1].start,
          "end": eventEnd[1].end
        };
        const art2 = { ...artificialToken, "type": "undefinedReference" };
        const rel = events.slice(indexStart);
        const dataEvents = rel.filter((event) => ["data", "lineEnding"].includes(event[1].type));

        // ...
        let skip = false;
        const prev = artificialEventLists.length && artificialEventLists[artificialEventLists.length - 1][0];
        if (prev && (prev[1].end.line === artificialToken.start.line) && (prev[1].end.column === artificialToken.start.column)) {
          if (dataEvents.length === 0) {
            prev[1].type = "undefinedReferenceCollapsed";
            prev[1].end = eventEnd[1].end;
            // const pl = artificialEventLists[artificialEventLists.length - 1];
            // pl.splice(pl.length - 1, 0, ...rel.filter((event) => event[1].type === "labelMarker"));
            skip = true;
          } else {
            artificialToken.type = "undefinedReferenceFull";
            const pp = artificialEventLists.pop();
            artificialToken.start = pp[0][1].start;
          }
        }

        if (!skip) {
          const dataText = dataEvents.filter((de) => de[0] === "enter").map((de) => tokenizeContext.sliceSerialize(de[1])).join("").trim();
          if (
            (dataText.length > 0) &&
            !dataText.includes("]")
          ) {
            /** @type {Event[]} */
            const artificialEvents = [];
            artificialEvents.push([ "enter", artificialToken, tokenizeContext ]);
            artificialEvents.push([ "enter", art2, tokenizeContext ]);
            for (const event of dataEvents) {
              artificialEvents.push([ event[0], { ...event[1] }, tokenizeContext ]);
            }
            artificialEvents.push([ "exit", art2, tokenizeContext ]);
            artificialEvents.push([ "exit", artificialToken, tokenizeContext ]);
            artificialEventLists.push(artificialEvents);
          }
        }
      }

      // Continue with original behavior
      return nokOriginal(code);
    };

    // Shim nok handler of labelEnd's tokenize
    return tokenizeOriginal.call(tokenizeContext, effects, okOriginal, nokShim);
  }

  try {
    // Shim labelEnd behavior
    labelEnd.tokenize = tokenizeShim;

    // Use micromark to parse document into Events
    const encoding = undefined;
    const eol = true;
    const parseContext = micromark.parse(micromarkParseOptions);
    if (shimReferences) {
      // Customize ParseContext to treat all references as defined
      // parseContext.defined.includes = (searchElement) => searchElement.length > 0;
    }
    const chunks = micromark.preprocess()(markdown, encoding, eol);
    let events = micromark.postprocess(parseContext.document().write(chunks));

    // Append artificial events and return all events
    for (const artificialEventList of artificialEventLists) {
      events = events.concat(artificialEventList);
    }
    return events;

  } finally {
    // Restore labelEnd behavior
    labelEnd.tokenize = tokenizeOriginal;
  }
}

/**
 * Parses a Markdown document and returns micromark tokens (internal).
 *
 * @param {string} markdown Markdown document.
 * @param {ParseOptions} [parseOptions] Options.
 * @param {MicromarkParseOptions} [micromarkParseOptions] Options for micromark.
 * @param {number} [lineDelta] Offset for start/end line.
 * @param {MicromarkToken} [ancestor] Parent of top-most tokens.
 * @returns {MicromarkToken[]} Micromark tokens.
 */
function parseInternal(
  markdown,
  parseOptions = {},
  micromarkParseOptions = {},
  lineDelta = 0,
  ancestor = undefined
) {
  // Get options
  const freezeTokens = Boolean(parseOptions.freezeTokens);

  // Use micromark to parse document into Events
  const events = getEvents(markdown, parseOptions, micromarkParseOptions);

  // Create Token objects
  const document = [];
  let flatTokens = [];
  /** @type {MicromarkToken} */
  const root = {
    "type": "data",
    "startLine": -1,
    "startColumn": -1,
    "endLine": -1,
    "endColumn": -1,
    "text": "ROOT",
    "children": document,
    "parent": null
  };
  const history = [ root ];
  let current = root;
  // eslint-disable-next-line jsdoc/valid-types
  /** @type MicromarkParseOptions | null */
  let reparseOptions = null;
  let lines = null;
  let skipHtmlFlowChildren = false;
  for (const event of events) {
    const [ kind, token, context ] = event;
    const { type, start, end } = token;
    const { "column": startColumn, "line": startLine } = start;
    const { "column": endColumn, "line": endLine } = end;
    const text = context.sliceSerialize(token);
    if ((kind === "enter") && !skipHtmlFlowChildren) {
      const previous = current;
      history.push(previous);
      current = {
        type,
        "startLine": startLine + lineDelta,
        startColumn,
        "endLine": endLine + lineDelta,
        endColumn,
        text,
        "children": [],
        "parent": ((previous === root) ? (ancestor || null) : previous)
      };
      if (ancestor) {
        Object.defineProperty(current, htmlFlowSymbol, { "value": true });
      }
      previous.children.push(current);
      flatTokens.push(current);
      if ((current.type === "htmlFlow") && !isHtmlFlowComment(current)) {
        skipHtmlFlowChildren = true;
        if (!reparseOptions || !lines) {
          reparseOptions = {
            ...micromarkParseOptions,
            "extensions": [
              {
                "disable": {
                  "null": [ "codeIndented", "htmlFlow" ]
                }
              }
            ]
          };
          lines = markdown.split(newLineRe);
        }
        const reparseMarkdown = lines
          .slice(current.startLine - 1, current.endLine)
          .join("\n");
        const tokens = parseInternal(
          reparseMarkdown,
          parseOptions,
          reparseOptions,
          current.startLine - 1,
          current
        );
        current.children = tokens;
        // Avoid stack overflow of Array.push(...spread)
        // eslint-disable-next-line unicorn/prefer-spread
        flatTokens = flatTokens.concat(tokens[flatTokensSymbol]);
      }
    } else if (kind === "exit") {
      if (type === "htmlFlow") {
        skipHtmlFlowChildren = false;
      }
      if (!skipHtmlFlowChildren) {
        if (freezeTokens) {
          Object.freeze(current.children);
          Object.freeze(current);
        }
        // @ts-ignore
        current = history.pop();
      }
    }
  }

  // Return document
  Object.defineProperty(document, flatTokensSymbol, { "value": flatTokens });
  if (freezeTokens) {
    Object.freeze(document);
  }
  return document;
}

/**
 * Parses a Markdown document and returns micromark tokens.
 *
 * @param {string} markdown Markdown document.
 * @param {ParseOptions} [parseOptions] Options.
 * @returns {MicromarkToken[]} Micromark tokens.
 */
function parse(markdown, parseOptions) {
  return parseInternal(markdown, parseOptions);
}

module.exports = {
  getEvents,
  parse
};

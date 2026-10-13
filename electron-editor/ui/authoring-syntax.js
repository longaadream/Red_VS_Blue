(function (global) {
  'use strict';

  // The preview accepts the same punctuation in full-width and half-width
  // form.  This helper deliberately folds syntax only: authored strings are
  // copied byte-for-byte (including full-width punctuation) and the caller's
  // draft is never changed.
  var quotePairs = {
    '“': { close: '”', output: '"' },
    '‘': { close: '’', output: "'" },
    '「': { close: '」', output: '"' },
    '『': { close: '』', output: '"' },
    '＂': { close: '＂', output: '"' },
    '＇': { close: '＇', output: "'" },
    '"': { close: '"', output: '"' },
    "'": { close: "'", output: "'" }
  };

  function ascii(char) {
    var code = char.charCodeAt(0);
    if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
    if (code === 0x3000) return ' ';
    return char;
  }

  function normalize(text, memberDotsOnly) {
    var value = String(text == null ? '' : text);
    var result = '';
    var quote = null;
    var escaped = false;

    for (var index = 0; index < value.length; index += 1) {
      var original = value[index];
      if (quote) {
        // Remember the source opening delimiter. This keeps a full-width or
        // Chinese quote inside an ASCII string as literal content rather than
        // accidentally closing it after folding.
        if (!escaped && original === quote.close) {
          result += memberDotsOnly ? original : quote.output;
          quote = null;
          continue;
        }
        result += original;
        if (escaped) {
          escaped = false;
        } else if (original === '\\') {
          escaped = true;
        }
        continue;
      }

      var folded = ascii(original);
      if (quotePairs[original]) {
        quote = quotePairs[original];
        result += memberDotsOnly ? original : quote.output;
        continue;
      }
      if (original === '”' || original === '’' || original === '」' || original === '』') {
        // A closing Chinese quote without an opening quote is still a syntax
        // delimiter.  Treat it as its matching ASCII quote so the result can
        // be consumed by the small preview parsers.
        result += memberDotsOnly ? original : original === '’' ? "'" : '"';
        continue;
      }
      if (folded === '"' || folded === "'") {
        quote = quotePairs[folded];
        result += folded;
        continue;
      }
      result += original === '。' ? '.' : memberDotsOnly ? original : folded;
    }
    return result;
  }

  global.AuthoringSyntax = {
    normalize: normalize,
    normalizeMemberDots: function (value) { return normalize(value, true); },
    // Keep the British spelling available to the existing preview helpers.
    normalise: normalize
  };
})(typeof window === 'undefined' ? globalThis : window);

'use strict';

/**
 * Parse raw subtitle text (SRT or WebVTT) into an array of cue objects.
 *
 * Handles both formats transparently:
 *   - SRT:  numeric id line, then `00:00:01,200 --> 00:00:03,938`
 *   - VTT:  optional `WEBVTT` header, optional cue id line, then
 *           `00:00:01.200 --> 00:00:03.938` (with optional cue settings after)
 *
 * Detection is structural rather than by extension: for each block we locate
 * the line containing `-->`, parse the timestamps from it, and treat every
 * following line as cue text. Anything before that line (numeric id or VTT
 * cue identifier) is ignored. Millisecond separators (`,` or `.`) are both
 * accepted and normalized to `,` for SRT-style output.
 */
function parseSRT(raw) {
  // Normalize: strip BOM, normalize line endings
  let text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Drop the WEBVTT header block (header line + any metadata up to first blank line)
  if (/^WEBVTT/.test(text.trim())) {
    text = text.replace(/^WEBVTT[^\n]*\n(?:[^\n]*\n)*?\n/, '');
  }

  const cues = [];
  const blocks = text.trim().split(/\n\n+/);
  const timeRe = /(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})/;

  for (const block of blocks) {
    const lines = block.split('\n');

    // Find the line that holds the timestamps (line 0 for VTT w/o id, line 1 for SRT)
    const timeIdx = lines.findIndex((l) => timeRe.test(l));
    if (timeIdx === -1) continue;

    const timeMatch = lines[timeIdx].match(timeRe);
    const start = timeMatch[1].replace('.', ',');
    const end = timeMatch[2].replace('.', ',');

    // Everything after the timestamp line is the cue text; strip inline VTT tags
    const cueText = lines
      .slice(timeIdx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '') // <c>, <v Speaker>, <00:00:01.000> etc.
      .trim();

    if (!cueText) continue;

    const id = timeIdx > 0 ? lines[0].trim() : String(cues.length + 1);
    cues.push({ id, start, end, text: cueText });
  }

  return cues;
}

/**
 * Serialize cue array back to SRT string.
 */
function serializeSRT(cues) {
  return cues
    .map((cue, i) => `${i + 1}\n${cue.start} --> ${cue.end}\n${cue.text}`)
    .join('\n\n') + '\n';
}

module.exports = { parseSRT, serializeSRT };

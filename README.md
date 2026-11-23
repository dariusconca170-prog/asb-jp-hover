# JP Subtitle Hover

Companion extension for [asbplayer](https://github.com/asbplayer/asbplayer) (works on any page with
selectable Japanese subtitles). Hover a word in a subtitle line: get its reading, English glosses and
an English translation of the whole line.

No build step — plain MV3, load it unpacked.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `asb-jp-hover` folder
3. Click the extension icon → paste your API key → **Save** → **Test lookup**
4. Reload any tab that was open before installing

## API key

Cheapest fast option is Groq (`https://console.groq.com/keys`). The free plan is roughly
30 requests/min, 1,000 requests/day, 8,000 tokens/min and 200,000 tokens/day per organization.
One request covers one whole subtitle line, and every line is cached (memory + IndexedDB), so
normal viewing sits far below those limits; only new lines cost a request.

Any OpenAI-compatible endpoint works (Cerebras, OpenRouter, Gemini's OpenAI-compatible endpoint,
local Ollama) via **Base URL** + **Model**.

## Notes

- Hover delay, endpoint and model are configurable; `Escape` closes the popup.
- Works through open shadow roots and iframes (asbplayer renders subtitles into the page/frames).
- Subtitle text that is drawn on a `<canvas>` (hardsubs, some streaming players) has no text to hover.
- Cached analyses live for 60 days in IndexedDB.

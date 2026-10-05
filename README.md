# Infographic Studio

Internal tool for creating the 3 to 4 infographic images of an Amazon listing.
Claude writes the prompts and reviews the results; Nano Banana Pro (Gemini image model) draws the images.

## Setup

Requires Node 22.13 or newer (the database uses Node's built-in SQLite, so there is nothing native to compile).

```bash
npm install
cp .env.local.example .env.local   # then fill in the keys
npm run dev                        # http://localhost:3000
# for production: npm run build && npm start
```

`.env.local`:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude: writes prompts, reviews images |
| `GEMINI_API_KEY` | Nano Banana Pro image generation (Google Gemini API) |
| `APP_PASSWORD` | One shared team password. Leave empty to disable the login (local use only) |
| `CLAUDE_MODEL` | Optional, default `claude-sonnet-5-5` |
| `GEMINI_IMAGE_MODEL` | Optional, default `gemini-3-pro-image-preview` |
| `IMAGE_SIZE` | Optional, `1K`, `2K` (default) or `4K`. Images are square (1:1) |
| `DATA_DIR` | Optional, where the database and images live (default `./data`). Back this folder up. |

Keys stay on the server and are never sent to the browser.

## The dashboard

- **Dashboard**: the latest approved images as a contact sheet, summary numbers, a "Needs your attention" list (images to review, prompts to choose, errors), brand folders and recent products. Search finds any brand or product.
- **Brand folders** (left sidebar and dashboard): each brand is a folder holding its products. Open one to see its product cards, or switch to the Brand profile tab to edit logo, colors, fonts and tone.
- **Product workspace**: a strip of all its images at the top, one card per image, and the product details and auto mode on the right.
- Fonts (Bricolage Grotesque and Figtree) load from Google Fonts; without internet the app falls back to system fonts and works the same.

## How it works

1. **Brand**: name, logo, colors, fonts, tone, do's and don'ts. Used in every prompt.
2. **Product**: name, details, 1 to 3 real photos (required). Photos and logo are sent to the image model as references so it draws your actual product. A new product starts with 4 image slots (features, benefits, dimensions, how to use); add, delete or change them, up to 6.
3. **Each image slot**: write a short brief, then
   - Claude writes **3 prompt variations** (and marks the one it recommends). You can edit any prompt.
   - Pick one and the image is generated.
   - An **automatic quality check** reviews spelling, product match against your photos, layout, brand and risky claims, and shows the findings under the image.
   - **Redo**: add an optional note ("product too small"). Claude looks at the image, writes **one** new prompt from the old prompt, your note and the image, and regenerates. Every version is kept; click a thumbnail to go back and approve an older one.
4. **Auto mode** (per product, never global):
   - **Full auto**: for every slot Claude writes prompts, picks the best, generates, quality-checks, and retries up to the product's retry limit (default 2). Images that pass are approved; ones that do not are flagged for your review.
   - **Auto with fine-tune**: you pick a style anchor image (default image 1) and work on it by hand (3 variations, redo until you like it) and press Approve. Claude then writes a style spec from the approved image and the other images run automatically in that style, one prompt each, with the anchor also sent as a visual reference. The style spec is editable, and a button re-runs the other images if you change the anchor later.
   - Stop pauses after the step in progress. Nothing is spent while the app waits for you.
5. **Download all** gives a zip with correctly named images plus the prompts used.

## Prompt templates (Settings, "Prompt templates")

The instructions Claude follows live in the app, not in the code: variation prompts, redo prompt, style spec, quality check.
- Placeholders such as `{{brand_name}}` or `{{slot_brief}}` are filled in automatically (click one to insert it). Unknown ones are flagged.
- A fixed output-format block is appended to each template (visible, not editable) so the app can always read Claude's answer.
- Every save is a new version; each generated prompt records which version made it. Load any old version back into the editor, or reset to default.
- Global templates apply to all brands; a brand can have its own override (remove it to inherit global again).
- The Test button runs a draft variation template on a real slot without saving or generating images.

## Tests

```bash
npm test      # core logic with a fake AI and a temporary database
```
`scripts/test-api.mjs` exercises every API route, including the dashboard summary, the same way (`npx tsx --tsconfig jsconfig.json scripts/test-api.mjs`).

## Notes and limits

- Long jobs run inside the server process. Keep the server running while images generate. If it restarts mid-job, that image shows an error and you can retry.
- Image generation and quality checks cost API credits; auto mode multiplies them (3 prompts + image + check per image, plus retries).
- The quality check is a second opinion from Claude, not a guarantee. Always look at the final images, especially spelling and product accuracy.

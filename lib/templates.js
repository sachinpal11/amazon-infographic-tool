import { all, get, run, now } from './db.js';

export const TEMPLATE_KEYS = ['variations', 'redo', 'style_spec', 'qc'];

export const TEMPLATE_META = {
  variations: {
    title: 'Variation prompts',
    description:
      'How Claude writes the image-generation prompt variations for a slot. Also used for the single prompt per slot in auto mode.',
  },
  redo: {
    title: 'Redo prompt',
    description:
      'How Claude writes ONE new prompt after you press Redo (or after a failed automatic quality check). It sees the old prompt, your note and the generated image.',
  },
  style_spec: {
    title: 'Style spec (fine-tune mode)',
    description:
      'How Claude describes the approved anchor image so every other image in the product can match its style.',
  },
  qc: {
    title: 'Quality check',
    description:
      'What Claude looks for when it reviews a generated image (spelling, product match, layout, brand, claims).',
  },
};

export const PLACEHOLDERS = [
  { name: 'brand_name', description: 'Brand name' },
  { name: 'brand_colors', description: 'Brand colors' },
  { name: 'brand_fonts', description: 'Brand fonts' },
  { name: 'brand_tone', description: 'Brand tone of voice' },
  { name: 'brand_dos', description: 'Brand "always do" rules' },
  { name: 'brand_donts', description: 'Brand "never do" rules' },
  { name: 'brand_notes', description: 'Other brand notes' },
  { name: 'product_name', description: 'Product name' },
  { name: 'product_details', description: 'Product details' },
  { name: 'slot_type', description: 'Type of this image (Features, Benefits, ...)' },
  { name: 'slot_type_guidance', description: 'Built-in guidance for that image type' },
  { name: 'slot_brief', description: 'The brief you wrote for this image' },
  { name: 'slot_position', description: 'Position of this image in the set (1, 2, ...)' },
  { name: 'total_slots', description: 'Number of infographic images for the product' },
  { name: 'other_slot_briefs', description: 'Briefs of the other images in the set' },
  { name: 'style_spec', description: 'Locked style description (fine-tune / auto mode)' },
  { name: 'variation_count', description: 'How many variations to write (3, or 1 in auto mode)' },
  { name: 'previous_prompt', description: 'Prompt that produced the current image (redo / quality check)' },
  { name: 'user_note', description: 'Your redo note, or the quality-check findings in auto retries' },
  { name: 'generated_prompt', description: 'Prompt used for the image being reviewed (quality check)' },
];

export const SLOT_TYPES = {
  features: {
    label: 'Features',
    guidance:
      'Show the product clearly with 4 to 6 callouts that point at its key features. Each callout is a short title plus at most 6 words of support text.',
  },
  benefits: {
    label: 'Benefits',
    guidance:
      'Turn features into customer benefits using icons and short headlines. May show the product in use, but the product must stay accurate.',
  },
  dimensions: {
    label: 'Dimensions / size',
    guidance:
      'Show the product with dimension lines and labels. Use ONLY the measurements and units given in the brief or product details. Never invent a number.',
  },
  comparison: {
    label: 'Comparison',
    guidance:
      'Compare this product with a generic alternative in a simple two-column layout. Never name or show competitor brands.',
  },
  how_to_use: {
    label: 'How to use',
    guidance:
      'Show 3 or 4 numbered steps. Each step has a small visual, a short title and one short line. Keep the flow obvious left to right or top to bottom.',
  },
  whats_in_box: {
    label: "What's in the box",
    guidance:
      'Lay out every item included, neatly arranged, each with a clear label and quantity. Include only items listed in the brief or product details.',
  },
  other: {
    label: 'Other',
    guidance: 'Follow the brief closely and keep the layout clean, with a clear visual hierarchy.',
  },
};

// ---------------------------------------------------------------------------
// Default templates (editable in the app)
// ---------------------------------------------------------------------------
export const DEFAULTS = {
  variations: `You are a senior Amazon listing designer and an expert prompt writer for AI image generation (Nano Banana Pro). Your prompts produce infographic images for the image gallery of an Amazon product listing.

BRAND
- Name: {{brand_name}}
- Colors: {{brand_colors}}
- Fonts: {{brand_fonts}}
- Tone of voice: {{brand_tone}}
- Always do: {{brand_dos}}
- Never do: {{brand_donts}}
- Other notes: {{brand_notes}}

PRODUCT
- Name: {{product_name}}
- Details: {{product_details}}

THIS IMAGE
- Position: image {{slot_position}} of {{total_slots}} in the infographic set
- Type: {{slot_type}}
- What this type needs: {{slot_type_guidance}}
- Brief from the team (follow it closely): {{slot_brief}}

THE OTHER INFOGRAPHICS IN THE SET (do not repeat their content)
{{other_slot_briefs}}

LOCKED STYLE
{{style_spec}}

YOUR TASK
Write {{variation_count}} prompt(s) for the image model. Each prompt must be complete and self-contained, because the image model sees nothing except the prompt and the reference photos.

RULES FOR EVERY PROMPT
1. Product fidelity: the real product photos are attached as reference images. Tell the image model to reproduce the product exactly as in the reference photos (shape, colors, parts, label, proportions) and never to invent, remove or alter features.
2. Canvas: a square 1:1 image, designed for an Amazon listing gallery. The product must be large and clearly the hero, and every element must stay inside safe margins so nothing is cut off.
3. Text on the image: write every word that must appear inside straight double quotes, exactly as it should be spelled. English only. Keep text short: headline of at most 6 words, callouts of at most 8 words. Ask for large, high-contrast, perfectly legible lettering.
4. Layout: describe the composition concretely, including background, where the product sits, where each callout, icon or number goes, the visual hierarchy, and how callouts connect to the product.
5. Brand: use the brand colors (give hex codes if known), the font style, and the logo if one is attached. Reproduce the logo exactly and do not redraw it.
6. Amazon safety: no unverifiable claims, no "#1", "best seller", "guaranteed" or medical claims, no competitor names, no prices, no review stars, no watermarks.
7. Variations: if a LOCKED STYLE is given, every variation must follow it exactly and may only differ in small layout details. If no style is locked, each variation must be a genuinely different concept (different layout, composition and background treatment), not a reworded copy.`,

  redo: `You are a senior Amazon listing designer and an expert prompt writer for AI image generation (Nano Banana Pro). An infographic image was generated and needs to be improved. Write ONE new, complete prompt that fixes the problems.

BRAND
- Name: {{brand_name}}
- Colors: {{brand_colors}}
- Fonts: {{brand_fonts}}
- Tone of voice: {{brand_tone}}
- Always do: {{brand_dos}}
- Never do: {{brand_donts}}

PRODUCT
- Name: {{product_name}}
- Details: {{product_details}}

THIS IMAGE
- Type: {{slot_type}} (image {{slot_position}} of {{total_slots}})
- Original brief: {{slot_brief}}

LOCKED STYLE
{{style_spec}}

PROMPT THAT PRODUCED THE CURRENT IMAGE
{{previous_prompt}}

WHAT NEEDS TO CHANGE
{{user_note}}

YOUR TASK
Look carefully at the generated image (the first attached image). Decide what is wrong or weak, using the notes above as the main guide, and write one new prompt that keeps what worked and fixes what did not. If the notes are empty, take a clearly fresh but better approach to the same brief.

The same rules apply as for any prompt: reproduce the product exactly as in the reference photos; keep a square 1:1 composition with safe margins; write every on-image word in straight double quotes, short, English and correctly spelled; describe the layout concretely; follow the brand; and avoid unverifiable claims. If a LOCKED STYLE is given, keep following it. The new prompt must be fully self-contained: do not refer to "the previous image" or "the old prompt".`,

  style_spec: `You are an art director. The attached image is an approved infographic for an Amazon listing. Write a style specification that another designer could follow to make more images that look like they belong to the same set, without copying this image's content.

BRAND
- Name: {{brand_name}}
- Colors: {{brand_colors}}
- Fonts: {{brand_fonts}}

Describe, in concrete and reusable terms:
1. Background (type, colors, gradients, textures, lighting)
2. Color usage (main, accent and text colors, with hex codes where you can tell)
3. Typography (font style, weights, sizes relative to the canvas, capitalization, alignment)
4. Product treatment (size on the canvas, angle, shadow, reflection, cut-out edge)
5. Callouts and icons (shape, line weight, fill, corner radius, how connectors are drawn)
6. Layout language (margins, grid, where headlines usually sit, spacing, density)
7. Overall mood and any recurring decorative elements

Be specific. Use at most 250 words. Do not describe the product itself or the specific words on this image.`,

  qc: `You are a strict quality reviewer for Amazon listing infographic images. The first attached image is the generated infographic to review. The other attached images are the real product photos and the brand logo.

BRAND
- Name: {{brand_name}}
- Colors: {{brand_colors}}
- Never do: {{brand_donts}}

PRODUCT
- Name: {{product_name}}
- Details: {{product_details}}

THIS IMAGE
- Type: {{slot_type}}
- Brief: {{slot_brief}}

PROMPT THAT WAS USED
{{generated_prompt}}

CHECK EACH OF THESE
1. Spelling and text: read every word on the image. Flag typos, garbled or cut-off words, wrong characters, and any text that differs from what the prompt asked for. Flag text that is too small or low-contrast to read on a phone.
2. Product fidelity: compare the product in the image with the reference photos. Flag a different shape, wrong colors, missing or extra parts, a changed label, distorted proportions, or invented features.
3. Layout: flag overlapping elements, anything cropped at the edges, unreadable or tiny text, clutter, unbalanced composition, a product that is too small, and connector lines that point at the wrong part.
4. Brand and compliance: flag a missing or redrawn logo, colors that clash with the brand, and risky claims ("#1", "best seller", "guaranteed", medical claims, competitor names, prices, review stars).
5. Numbers: if the image shows measurements or quantities, check they match the brief and product details.

Use severity "error" for anything that makes the image unusable for a listing (wrong product, misspelled text, cut-off content, wrong numbers, illegible text). Use "warning" for small issues that could be improved. Be honest and specific, and do not invent problems.`,
};

// Fixed part appended to every template. Shown in the editor but not editable,
// so one wrong edit cannot break the app.
export const LOCKED = {
  variations: `OUTPUT FORMAT (fixed by the app, do not change)
Reply with one JSON object and nothing else, with no markdown fences:
{"variations":[{"label":"2-4 word name for the concept","prompt":"the complete image-generation prompt"}],"recommended":0}
"variations" must contain exactly {{variation_count}} item(s). "recommended" is the 0-based index of the variation you expect to give the best Amazon-ready image.`,
  redo: `OUTPUT FORMAT (fixed by the app, do not change)
Reply with one JSON object and nothing else, with no markdown fences:
{"prompt":"the complete new image-generation prompt"}`,
  style_spec: `OUTPUT FORMAT (fixed by the app, do not change)
Reply with the style specification as plain text only. No preamble, no markdown headings.`,
  qc: `OUTPUT FORMAT (fixed by the app, do not change)
Reply with one JSON object and nothing else, with no markdown fences:
{"pass":true,"summary":"one sentence verdict","issues":[{"severity":"error","category":"spelling","message":"specific description of the problem"}]}
"category" is one of: spelling, product_fidelity, layout, brand, claims, other. "pass" must be false if there is at least one issue with severity "error". Use an empty "issues" array when the image is fine.`,
};

// ---------------------------------------------------------------------------
// Storage: global templates and optional per-brand overrides, with versions
// ---------------------------------------------------------------------------
function latest(scope, key) {
  return get(
    'SELECT * FROM template_versions WHERE scope=? AND key=? ORDER BY version DESC LIMIT 1',
    scope,
    key
  );
}

// Brand override (if any) -> global edit (if any) -> built-in default.
export function getTemplate(key, brandId) {
  if (brandId) {
    const b = latest('brand:' + brandId, key);
    if (b && b.content.trim()) {
      return { content: b.content, version: `brand:${brandId}:v${b.version}`, source: 'brand' };
    }
  }
  const g = latest('global', key);
  if (g && g.content.trim()) {
    return { content: g.content, version: `global:v${g.version}`, source: 'global' };
  }
  return { content: DEFAULTS[key], version: 'default', source: 'default' };
}

export function saveTemplate(scope, key, content) {
  const last = latest(scope, key);
  const version = (last ? last.version : 0) + 1;
  run(
    'INSERT INTO template_versions (scope,key,content,version,created_at) VALUES (?,?,?,?,?)',
    scope,
    key,
    content,
    version,
    now()
  );
  return version;
}

export function templateHistory(scope, key) {
  return all(
    'SELECT version, content, created_at FROM template_versions WHERE scope=? AND key=? ORDER BY version DESC LIMIT 30',
    scope,
    key
  );
}

export function unknownPlaceholders(content) {
  const known = new Set(PLACEHOLDERS.map((p) => p.name));
  const found = [...String(content).matchAll(/\{\{\s*([A-Za-z_]+)\s*\}\}/g)].map((m) => m[1]);
  return [...new Set(found.filter((n) => !known.has(n)))];
}

export function fillTemplate(content, vars) {
  return String(content).replace(/\{\{\s*([A-Za-z_]+)\s*\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
  );
}

export function buildPrompt(key, content, vars, attachNote) {
  const attach = attachNote ? `\n\nATTACHED IMAGES\n${attachNote}` : '';
  return fillTemplate(`${content}${attach}\n\n${LOCKED[key]}`, vars);
}

import { json, handle, HttpError } from '@/lib/http.js';
import { actVariations, actChoose, actGenerate, actRedo, actApprove } from '@/lib/pipeline.js';

// Every action returns immediately; the work continues in the background and the
// page polls the product for progress.
export const POST = handle(async (req, { params }) => {
  const { id, action } = await params;
  const slotId = Number(id);
  const body = await req.json().catch(() => ({}));
  switch (action) {
    case 'variations':
      actVariations(slotId);
      break;
    case 'choose':
      actChoose(slotId, Number(body.promptId), body.text);
      break;
    case 'generate':
      actGenerate(slotId);
      break;
    case 'redo':
      actRedo(slotId, body.note);
      break;
    case 'approve':
      actApprove(slotId, body.imageId ? Number(body.imageId) : undefined);
      break;
    default:
      throw new HttpError(404, 'Unknown action');
  }
  return json({ ok: true });
});

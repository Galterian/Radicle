// channel-rule.mjs — when does a channelled effect (Harm, Combustion, The Void, Light/Darkness) break?
// Pure: used by peer.mjs simulate()#channelBreaksFor and the oracle in tools/classes-check.mjs.
//
// general_ux_channeling: the channel ends the moment the caster breaks concentration — plays A, B, M or EM, or
// emits an element other than the channel's cost element.
// User ruling 2026-11-17: a Reaver's Attack and a Barbarian's Block are class emissions — like a Posture they keep
// the holder's channel going (only an emitted element other than the cost still breaks it). Exactly a plain A / B by a
// class that emits on that code (classes.mjs `emits`); a Battle Trance pair, a Monk's Move, or A / B by anyone else
// still break it.
export const CHANNEL_BREAK = Object.freeze(new Set(['A', 'B', 'M', 'EM']));

// rev: the holder's reveal {action, declared, trance: [codes] | null, effect: {elements, step} | null}
// costElem: the channel's cost element. classEmits(code) → bool: does the holder's class emit on that code (plan site)?
// → { breaks: bool, kept: bool }  (kept = the class exception saved a channel that the action alone would break)
export function channelBreaks(rev, costElem, classEmits) {
  if (!rev) return { breaks: false, kept: false };
  // What the player put down (a class stance turning EP into B/A/M is not the player moving).
  const act = rev.trance ? rev.trance.find(c => CHANNEL_BREAK.has(c)) || rev.trance[0] : (rev.declared ?? rev.action);
  const classKeeps = (act === 'A' || act === 'B') && !rev.trance && typeof classEmits === 'function' && !!classEmits(act);
  if (CHANNEL_BREAK.has(act) && !classKeeps) return { breaks: true, kept: false };
  if (rev.effect && Array.isArray(rev.effect.elements) && rev.effect.elements.length) {
    const step = Math.max(1, rev.effect.step ?? 1);
    const emitted = rev.effect.elements[Math.min(step, rev.effect.elements.length) - 1];
    if (emitted && costElem && emitted !== costElem) return { breaks: true, kept: false };
  }
  return { breaks: false, kept: classKeeps };
}

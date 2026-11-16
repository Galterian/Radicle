// Hero shadows (rule_hero_shadow, user ruling 2026-11-16) — the profile side of a shadow's death.
//
// A shadow holds no real deck, so every hero publishes the card it would lose on death (peer.mjs deathCardRef →
// snapshot death_card_json); its shadow hands exactly that card to its killer through the ordinary gift path
// (evt_card_gift) and publishes shadow_death { killer, killer_name, card, gift_id, at } in its snapshot / Door.
// The player's own device (desktop launcher GET /api/dimensions, phone menu dimensions list, or the hero's peer
// itself when it hears its fallen shadow) then takes that card out of the profile character here — once per
// gift id (character.shadow_settled, synced with the character), counting a death like dropRandomDeckCard does.
// If the card is no longer in the deck, one random deck card goes instead (same death-card rule).
import { updateProfile, loadProfile } from './profile.mjs';
import { recordIsCharacter } from './join-plan.mjs';

const SETTLED_MAX = 64;

// `records` = shadow death records (join-plan.mjs shadowDeathsOf / describeDimension shadow_deaths, or a peer
// snapshot with shadow_death_json). → [{ character_id, name, gift_id, card, killer_name, text }] for the ones
// settled now (already settled / not mine → nothing).
export function settleShadowDeaths(file, records, rnd = Math.random) {
  const recs = (records || []).map(r => {
    let sd = r.shadow_death;
    if (!sd && r.shadow_death_json) { try { sd = JSON.parse(r.shadow_death_json); } catch { sd = null; } }
    return sd?.gift_id ? { ...r, shadow_death: sd } : null;
  }).filter(Boolean);
  if (!recs.length) return [];
  // Nothing of mine left to settle → no write (the list is read every few seconds).
  const pend = (p) => recs.some(r => { const c = p.characters.find(x => recordIsCharacter(r, x)); return c && !(c.shadow_settled || []).includes(r.shadow_death.gift_id); });
  if (!pend(loadProfile(file))) return [];
  return updateProfile(p => {
    const out = [];
    for (const r of recs) {
      const c = p.characters.find(x => recordIsCharacter(r, x));
      if (!c) continue;
      c.shadow_settled = Array.isArray(c.shadow_settled) ? c.shadow_settled : [];
      const sd = r.shadow_death;
      if (c.shadow_settled.includes(sd.gift_id)) continue;
      const inDeck = (c.cards || []).filter(x => x.where === 'deck');
      const want = sd.card && inDeck.find(x => x.kind === sd.card.kind && x.id === sd.card.id);
      const lost = want || (inDeck.length ? inDeck[Math.floor(rnd() * inDeck.length)] : null);
      if (lost) c.cards = c.cards.filter(x => x !== lost);
      c.deaths = (c.deaths | 0) + 1;
      c.shadow_settled = [...c.shadow_settled, sd.gift_id].slice(-SETTLED_MAX);
      const text = `${c.name}'s shadow was killed${sd.killer_name ? ` by ${sd.killer_name}` : ''}${sd.dim ? ` in ${sd.dim}` : ''} — ${lost ? `${lost.kind} ${lost.id} leaves the deck${want ? '' : ' (the published card was gone; a random one instead)'}` : 'no card left to lose'}`;
      out.push({ character_id: c.id, name: c.name, gift_id: sd.gift_id, card: lost ? { kind: lost.kind, id: lost.id } : null, killer_name: sd.killer_name || null, text });
    }
    return out;
  }, file);
}

// Over listed dimensions (describeDimension items with shadow_deaths, or raw { doors }).
export async function settleFromDimensions(file, dims) {
  const { shadowDeathsOf } = await import('./join-plan.mjs');
  const recs = [];
  for (const d of dims || []) recs.push(...(Array.isArray(d?.shadow_deaths) ? d.shadow_deaths : shadowDeathsOf(d?.doors || [])).map(r => ({ ...r, shadow_death: { ...r.shadow_death, dim: r.shadow_death?.dim || d.dimension_name } })));
  return recs.length ? settleShadowDeaths(file, recs) : [];
}

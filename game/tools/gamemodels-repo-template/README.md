# chaosD6-GameModels

The people of chaosD6, as data, in the Warlords Battlecry 3 world: **races**, their **buildings**, the **NPCs** who
live in their villages or wander 50–100 hexes around them, the **monsters**' agendas, the **village** templates the
map builds named villages from ("Silverleaf Village", "Ashford Village"), and the **quests** village NPCs give.
Every NPC and monster carries its **agenda** in JsonLogic; chaosD6 plays them all with one generic engine.

So far: the **High Elves** and the **Empire** (both villages, 16 buildings, 22 NPCs, 6 quests) and one agenda per
chaosD6 monster. The field reference is [SCHEMA.md](SCHEMA.md).

This repo is the **only** home of the definitions. chaosD6 finds the checkout next to it (or `CHAOSD6_GAMEMODELS_REPO`)
and compiles it into its `assets/gamemodels/catalog.json` with `node game/tools/gamemodels-build.mjs` — the one copy
every peer (and the phone) reads, so the deterministic map is the same everywhere.

## In the game

- **Villages** stand ≥ 100 hexes apart (one per 200×200-hex cell, and one 35–55 hexes from the spawn point). Each has a
  name from its race, a team `"<Name> Village"`, its buildings around a centre, and up to **20** units.
- An unpassable **wall** rings the village with one **gate**. The gate guard steps onto it to bar strangers and steps
  aside once the village welcomes you; until then the quest givers talk to you across the gate.
- **Buildings** have a **bank** threshold like the Dwarven Citadel: stand next to one and stat-buy it with the stat it
  names; at the threshold it breaks — and the village remembers who did it.
- **Producers** make one unit every N turns (e.g. a Longbow every 20) while the village is below its cap.
- **Quest givers** ask for an effect, a skill or a monster card ("bring me a Fireball", "the Barricade skill"); find it
  on the map if your archive lacks it, come back to the giver (at the gate will do): reputation, followers, a new card.
- The **centre** building (Tree of Gold, Archway) shows your relationship with the village, in percent: you start at
  50 % (70 % if your character is of the village's race); quests +5 %; hurting a villager, breaking a building or
  walking in uninvited −5 % each. At 70 % the gate opens; at 90 % every villager fights at your side; under 40 % the
  village attacks you when you come near it.
- Every village wears its own colour (never green or red); a village that counts you an ally shows the ally green.
- **Storytellers** tell you about the Dimension (other villages, where they lie, what roams near by).

## Layout

```
races/ buildings/ npcs/ monsters/ villages/ quests/ lib/   one definition per file, <id>.json
index.json         id → sha256(canonical JSON)            node tools/manifest.mjs [--check]
tools/check.mjs    the game's own checker, offline         npm install && node tools/check.mjs
tools/engine/      game/gamemodels.mjs + game/agenda.mjs, byte-identical (tools/pins.json)
```

## Proposing a new NPC / monster / quest

`main` holds the built-ins; only delegates write it. A proposal is a branch `players/<nid-or-name>/<slug>` = `main`
plus the new or changed definition file(s) and a regenerated `index.json`:

```bash
git switch -c players/alice/silverleaf-bard
$EDITOR npcs/npc_high_elves_bard.json        # or let the game's big model draft it
node tools/check.mjs && node tools/manifest.mjs
git push rad players/alice/silverleaf-bard && rad patch open
```

Never edit `tools/` (pinned). The game checks the ids your definition names (effects, skills, creatures) and its
sprites (chaosD6-Resources) when it takes it in.

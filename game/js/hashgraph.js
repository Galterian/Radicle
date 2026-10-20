// Local hashgraph tape. Events are wrapped in the message_envelope defined in
// sync_protocol.json#sync_handshake_per_action.data.message_envelope. For this
// prototype signatures are peer-id stubs; the shape, chaining and salt discipline
// are real so the artefacts are compatible with future libp2p/GunDB transport.

import { sha256Hex, digestObj } from './sha.js';
import { appendLine, sessionPaths } from './radicle.js';

export function makeHashgraph(dimension) {
  return {
    dimension,
    head: null,                 // sha256 of latest envelope
    perActorSelfParent: {},     // actor_peer_id -> last envelope hash
    lastOtherParent: null,      // most recent envelope seen (from any peer)
    events: [],                 // in-memory tape (debug / resolver)
    turn: 0,
    round: 0,
  };
}

export async function emit(hg, {
  type,            // one of the ids in hashgraph_events.json: evt_genesis, evt_join, ...
  actor,           // peer_id
  doorId = '-',
  payload,
  actionIndex = 0,
}) {
  const envelope = {
    type,
    dimension_id: hg.dimension.dimension_id,
    door_id: doorId,
    turn: hg.turn,
    round: hg.round,
    action_index: actionIndex,
    actor_peer_id: actor,
    self_parent: hg.perActorSelfParent[actor] || null,
    other_parent: hg.lastOtherParent,
    payload,
    timestamp: new Date().toISOString(),
    signature: `sig:${actor}:stub`,
  };
  const hash = await digestObj(envelope);
  envelope._hash = hash;

  hg.perActorSelfParent[actor] = hash;
  hg.lastOtherParent = hash;
  hg.head = hash;
  hg.events.push(envelope);

  await appendLine(sessionPaths.hashgraph(hg.dimension.dimension_name), envelope);
  return envelope;
}

export async function stateHashOfRegion(regionState) {
  return sha256Hex(JSON.stringify(regionState));
}

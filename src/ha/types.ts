export type EntityId = string;

export interface HaState {
  entity_id: EntityId;
  state: string;
  attributes: Record<string, any>;
  /** last_updated as epoch seconds (HA sends `lu`) */
  lu?: number;
}

/** Compressed initial payload from `subscribe_entities`. */
export interface CompressedAdd {
  s: string;                      // state
  a?: Record<string, any>;        // attributes
  c?: string | Record<string, any>; // context
  lc?: number;                    // last_changed
  lu?: number;                    // last_updated
}

/** Compressed delta payload. */
export interface CompressedChange {
  '+'?: { s?: string; a?: Record<string, any>; c?: any; lc?: number; lu?: number };
  '-'?: { a?: string[] };
}

export interface EntitiesEvent {
  a?: Record<EntityId, CompressedAdd>;      // full set (first message)
  c?: Record<EntityId, CompressedChange>;   // deltas
  r?: EntityId[];                           // removed
}

export type ConnState = 'idle' | 'connecting' | 'auth' | 'ready' | 'lost';

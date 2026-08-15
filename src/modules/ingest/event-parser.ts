/**
 * Parse Soroban pool/commitment/nullifier events into typed records.
 *
 * Layout (confirmed via probe / CAP-46 contractevent):
 *   topic[0] = event name Symbol (string after scValToNative)
 *   topic[1+] = #[topic] fields (e.g. commit_inserted.index, deposited.index)
 *   value = map/struct of non-topic fields
 *
 * See docs/event-layout.md
 */

export interface ParsedCommitInserted {
  kind: 'CommitInserted';
  index: number;
  leaf: string; // 0x
  root: string; // 0x
}

export interface ParsedNoteBlob {
  kind: 'NoteBlob';
  leafIndex: number;
  blob: string; // 0x hex
}

export interface ParsedNullifier {
  kind: 'NullifierSpent';
  nullifier: string; // 0x
}

export interface ParsedDeposited {
  kind: 'Deposited';
  index: number;
  amount: string;
}

export interface ParsedUnshielded {
  kind: 'Unshielded';
  nullifier: string;
  amount: string;
  changeIndex: number;
}

export type ParsedEvent =
  | ParsedCommitInserted
  | ParsedNoteBlob
  | ParsedNullifier
  | ParsedDeposited
  | ParsedUnshielded;

export function parsePoolEvent(
  name: string,
  topics: unknown[],
  value: unknown,
): ParsedEvent[] {
  const v = asRecord(value);
  // Soroban's #[contractevent] exposes Rust struct names as snake_case
  // symbols (for example `commit_inserted`). Keep accepting the historical
  // PascalCase spelling used by fixtures and older deployments.
  const eventName = name.replace(/_/g, '').toLowerCase();
  switch (eventName) {
    case 'commitinserted': {
      const index = num(topicAt(topics, 1) ?? v.index);
      const leaf = to0x(v.leaf);
      const root = to0x(v.root);
      return [{ kind: 'CommitInserted', index, leaf, root }];
    }
    case 'privatetransfer': {
      const out: ParsedEvent[] = [];
      for (const nf of collectNullifiers(v)) {
        out.push({ kind: 'NullifierSpent', nullifier: nf });
      }
      const i1 = num(v.out_index_1 ?? v.outIndex1);
      const i2 = num(v.out_index_2 ?? v.outIndex2);
      out.push({
        kind: 'NoteBlob',
        leafIndex: i1,
        blob: to0x(v.note_1 ?? v.note1),
      });
      out.push({
        kind: 'NoteBlob',
        leafIndex: i2,
        blob: to0x(v.note_2 ?? v.note2),
      });
      return out;
    }
    case 'nullifierspent': {
      return [{ kind: 'NullifierSpent', nullifier: to0x(v.nullifier) }];
    }
    case 'deposited': {
      return [
        {
          kind: 'Deposited',
          index: num(topicAt(topics, 1) ?? v.index),
          amount: String(v.amount ?? '0'),
        },
      ];
    }
    case 'unshielded': {
      return [
        {
          kind: 'Unshielded',
          nullifier: to0x(v.nullifier),
          amount: String(v.amount ?? '0'),
          changeIndex: num(v.change_index ?? v.changeIndex),
        },
        { kind: 'NullifierSpent', nullifier: to0x(v.nullifier) },
      ];
    }
    default:
      return [];
  }
}

function topicAt(topics: unknown[], i: number): unknown {
  return topics.length > i ? topics[i] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return parseInt(v, 10);
  throw new Error(`Expected number, got ${typeof v}`);
}

function collectNullifiers(v: Record<string, unknown>): string[] {
  const raw = v.nullifiers;
  if (Array.isArray(raw)) {
    return raw.map(to0x);
  }
  if (raw != null) {
    return [to0x(raw)];
  }
  if (v.nullifier != null) {
    return [to0x(v.nullifier)];
  }
  throw new Error('PrivateTransfer missing nullifier(s)');
}

function to0x(v: unknown): string {
  if (typeof v === 'string') {
    const s = v.startsWith('0x') || v.startsWith('0X') ? v : `0x${v}`;
    return s.toLowerCase().replace(/^0x/, '0x');
  }
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) {
    return `0x${Buffer.from(v).toString('hex')}`;
  }
  if (Array.isArray(v)) {
    return `0x${Buffer.from(v as number[]).toString('hex')}`;
  }
  throw new Error(`Expected bytes/hex, got ${typeof v}`);
}

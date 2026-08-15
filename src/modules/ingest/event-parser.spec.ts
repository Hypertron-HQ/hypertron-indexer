import { parsePoolEvent } from './event-parser';

describe('parsePoolEvent', () => {
  it('parses CommitInserted', () => {
    const out = parsePoolEvent(
      'CommitInserted',
      ['CommitInserted', 0],
      {
        leaf: Buffer.alloc(32, 1),
        root: Buffer.alloc(32, 2),
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'CommitInserted',
      index: 0,
    });
    if (out[0].kind === 'CommitInserted') {
      expect(out[0].leaf).toMatch(/^0x01/);
      expect(out[0].root).toMatch(/^0x02/);
    }
  });

  it('parses the snake_case names emitted by Soroban', () => {
    const commitment = parsePoolEvent(
      'commit_inserted',
      ['commit_inserted', 17],
      {
        leaf: Buffer.alloc(32, 1),
        root: Buffer.alloc(32, 2),
      },
    );
    const deposit = parsePoolEvent(
      'deposited',
      ['deposited', 17],
      { amount: 1000000000n },
    );

    expect(commitment[0]).toMatchObject({
      kind: 'CommitInserted',
      index: 17,
    });
    expect(deposit).toEqual([
      { kind: 'Deposited', index: 17, amount: '1000000000' },
    ]);
  });

  it('parses PrivateTransfer into nullifier + two blobs', () => {
    const out = parsePoolEvent('PrivateTransfer', ['PrivateTransfer'], {
      nullifier: Buffer.alloc(32, 3),
      out_index_1: 1,
      out_index_2: 2,
      note_1: Buffer.from('aa', 'hex'),
      note_2: Buffer.from('bb', 'hex'),
    });
    expect(out.map((x) => x.kind)).toEqual([
      'NullifierSpent',
      'NoteBlob',
      'NoteBlob',
    ]);
  });

  it('parses PrivateTransfer nullifiers vec into one NullifierSpent each', () => {
    const out = parsePoolEvent('private_transfer', ['private_transfer'], {
      nullifiers: [Buffer.alloc(32, 3), Buffer.alloc(32, 4)],
      out_index_1: 1,
      out_index_2: 2,
      note_1: Buffer.from('aa', 'hex'),
      note_2: Buffer.from('bb', 'hex'),
    });
    expect(out.map((x) => x.kind)).toEqual([
      'NullifierSpent',
      'NullifierSpent',
      'NoteBlob',
      'NoteBlob',
    ]);
    expect(out[0]).toMatchObject({ kind: 'NullifierSpent' });
    expect(out[1]).toMatchObject({ kind: 'NullifierSpent' });
    if (out[0].kind === 'NullifierSpent' && out[1].kind === 'NullifierSpent') {
      expect(out[0].nullifier).toMatch(/^0x03/);
      expect(out[1].nullifier).toMatch(/^0x04/);
    }
  });

  it('parses NullifierSpent', () => {
    const out = parsePoolEvent('NullifierSpent', ['NullifierSpent'], {
      nullifier: '0x' + 'ab'.repeat(32),
    });
    expect(out).toEqual([
      { kind: 'NullifierSpent', nullifier: '0x' + 'ab'.repeat(32) },
    ]);
  });

  it('parses snake_case transfer and nullifier events', () => {
    const transfer = parsePoolEvent('private_transfer', ['private_transfer'], {
      nullifier: Buffer.alloc(32, 3),
      out_index_1: 18,
      out_index_2: 19,
      note_1: Buffer.from('aa', 'hex'),
      note_2: Buffer.from('bb', 'hex'),
    });
    const nullifier = parsePoolEvent(
      'nullifier_spent',
      ['nullifier_spent'],
      { nullifier: Buffer.alloc(32, 4) },
    );

    expect(transfer.map((item) => item.kind)).toEqual([
      'NullifierSpent',
      'NoteBlob',
      'NoteBlob',
    ]);
    expect(nullifier[0]).toMatchObject({ kind: 'NullifierSpent' });
  });
});

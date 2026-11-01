// pako 1 ships no types; this is the part of its Inflate the clone reads.
declare module "pako" {
  export class Inflate {
    push(data: Uint8Array, mode: boolean): boolean;
    readonly err: number;
    readonly msg: string;
    readonly result: Uint8Array;
    readonly strm: { readonly avail_in: number };
  }
}

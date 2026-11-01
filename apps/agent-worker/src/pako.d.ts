// pako 1 ships no types; this is the part the clone and push use.
declare module "pako" {
  export class Inflate {
    push(data: Uint8Array, mode: boolean): boolean;
    readonly err: number;
    readonly msg: string;
    readonly result: Uint8Array;
    readonly strm: { readonly avail_in: number };
  }
  export function inflate(data: Uint8Array): Uint8Array;
  export function deflate(data: Uint8Array): Uint8Array;
}

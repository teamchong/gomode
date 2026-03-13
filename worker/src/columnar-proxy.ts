/**
 * Columnar Proxy — zero-copy access to WASM columnar tables.
 *
 * Creates JS Proxy objects that lazily read column data directly
 * from WASM linear memory via DataView. No deserialization needed.
 *
 * Usage:
 *   const table = new ColumnarTable(memory, exports, tableHandle, schema);
 *   const row = table.row(2);
 *   row.id    // reads Int32 directly from wasm memory
 *   row.name  // reads bytes from varlen column, decodes UTF-8
 *   row.score // reads Float64 directly from wasm memory
 *
 * The Proxy intercepts property access and translates to DataView reads
 * at the correct column offset — no intermediate objects allocated.
 */

const textDecoder = new TextDecoder();

export const enum ColType {
  I32 = 0,
  I64 = 1,
  F32 = 2,
  F64 = 3,
  Bytes = 4,
}

export interface ColumnSchema {
  name: string;
  type: ColType;
  index: number;
}

export interface WasmExports {
  zig_table_column_ptr(table: number, colIdx: number): number;
  zig_table_column_offsets(table: number, colIdx: number): number;
  zig_table_row_count(table: number): number;
  zig_table_free(table: number): void;
}

/**
 * A columnar table backed by WASM linear memory.
 * Provides zero-copy row access via JS Proxy.
 */
export class ColumnarTable {
  private view: DataView;
  private memory: WebAssembly.Memory;
  private exports: WasmExports;
  private tableHandle: number;
  private schema: Map<string, ColumnSchema>;
  private columnPtrs: Map<string, number>;
  private offsetPtrs: Map<string, number>;

  constructor(
    memory: WebAssembly.Memory,
    exports: WasmExports,
    tableHandle: number,
    columns: ColumnSchema[]
  ) {
    this.memory = memory;
    this.exports = exports;
    this.tableHandle = tableHandle;
    this.view = new DataView(memory.buffer);
    this.schema = new Map();
    this.columnPtrs = new Map();
    this.offsetPtrs = new Map();

    for (const col of columns) {
      this.schema.set(col.name, col);
      this.columnPtrs.set(
        col.name,
        exports.zig_table_column_ptr(tableHandle, col.index)
      );
      if (col.type === ColType.Bytes) {
        this.offsetPtrs.set(
          col.name,
          exports.zig_table_column_offsets(tableHandle, col.index)
        );
      }
    }
  }

  /** Refresh DataView after memory growth. */
  private refreshView(): void {
    if (this.view.buffer !== this.memory.buffer) {
      this.view = new DataView(this.memory.buffer);
    }
  }

  /** Read a single column value at the given row. */
  readValue(colName: string, rowIdx: number): number | bigint | string | null {
    this.refreshView();
    const col = this.schema.get(colName);
    if (!col) return null;

    const ptr = this.columnPtrs.get(colName)!;

    switch (col.type) {
      case ColType.I32:
        return this.view.getInt32(ptr + rowIdx * 4, true);
      case ColType.I64:
        return this.view.getBigInt64(ptr + rowIdx * 8, true);
      case ColType.F32:
        return this.view.getFloat32(ptr + rowIdx * 4, true);
      case ColType.F64:
        return this.view.getFloat64(ptr + rowIdx * 8, true);
      case ColType.Bytes: {
        const offPtr = this.offsetPtrs.get(colName)!;
        const start = this.view.getUint32(offPtr + rowIdx * 4, true);
        const end = this.view.getUint32(offPtr + (rowIdx + 1) * 4, true);
        const bytes = new Uint8Array(this.memory.buffer, ptr + start, end - start);
        return textDecoder.decode(bytes);
      }
    }
  }

  /** Get a Proxy object for a row — lazy, zero-copy field access. */
  row(idx: number): Record<string, number | bigint | string | null> {
    const table = this;
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "toJSON") {
            return () => {
              const obj: Record<string, unknown> = {};
              for (const [name] of table.schema) {
                obj[name] = table.readValue(name, idx);
              }
              return obj;
            };
          }
          return table.readValue(prop, idx);
        },
        has(_target, prop: string) {
          return table.schema.has(prop);
        },
        ownKeys() {
          return [...table.schema.keys()];
        },
        getOwnPropertyDescriptor(_target, prop: string) {
          if (table.schema.has(prop)) {
            return {
              configurable: true,
              enumerable: true,
              value: table.readValue(prop, idx),
            };
          }
          return undefined;
        },
      }
    );
  }

  /** Number of rows in the table. */
  get length(): number {
    return this.exports.zig_table_row_count(this.tableHandle);
  }

  /** Iterate rows as Proxy objects. */
  *[Symbol.iterator](): IterableIterator<
    Record<string, number | bigint | string | null>
  > {
    const len = this.length;
    for (let i = 0; i < len; i++) {
      yield this.row(i);
    }
  }

  /** Free the underlying WASM table. */
  free(): void {
    this.exports.zig_table_free(this.tableHandle);
  }
}

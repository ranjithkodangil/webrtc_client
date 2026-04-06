import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const MANUAL_BUNDLES = {
    mvp: {
        mainModule: duckdb_wasm,
        mainWorker: mvp_worker,
    },
    eh: {
        mainModule: duckdb_wasm_eh,
        mainWorker: eh_worker,
    },
};

let db = null;
let conn = null;
let queryQueue = Promise.resolve(); // Synchronization queue

// Helper to run queries sequentially to avoid transaction conflicts
const runQuery = async (queryString) => {
    queryQueue = queryQueue.then(async () => {
        if (!conn) return;
        return await conn.query(queryString);
    });
    return queryQueue;
};

export const initDB = async () => {
    if (db) return;

    try {
        const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
        const logger = new duckdb.ConsoleLogger();
        const worker = new Worker(bundle.mainWorker);
        db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        
        // Persistent OPFS attempt
        try {
            // Note: Different versions of duckdb-wasm use different names for the file protocols.
            // We'll try to find the best available one for browser-based persistent storage.
            const BrowserFS = duckdb.DuckDBFileType ? duckdb.DuckDBFileType.BrowserFS : 
                             (duckdb.DuckDBDataProtocol ? duckdb.DuckDBDataProtocol.BROWSER_FSACCESS : null);

            if (BrowserFS !== null) {
                await db.registerFileHandle('chat_history.db', null, BrowserFS, true);
            }

            await db.open({
                path: 'chat_history.db',
                accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
            });
            console.log('✅ DuckDB WASM Initialized (Persistent OPFS)');
        } catch (opfsError) {
            const errorMsg = opfsError.toString().toLowerCase();
            if (errorMsg.includes('locked') || errorMsg.includes('already exclusive')) {
                console.warn('⚠️ OPFS is locked. It appears you have another tab open. Falling back to in-memory mode.');
                await db.open({ path: ':memory:' });
                console.log('✅ DuckDB WASM Initialized (In-Memory Fallback)');
            } else {
                // For other errors (like the TypeError encountered), try to open in memory to at least allow chatting
                console.warn('⚠️ Could not open persistent DB, falling back to memory:', opfsError);
                await db.open({ path: ':memory:' });
            }
        }

        conn = await db.connect();
        
        // Create messages table
        await runQuery(`
            CREATE TABLE IF NOT EXISTS messages (
                id VARCHAR PRIMARY KEY,
                sender VARCHAR,
                content TEXT,
                timestamp BIGINT,
                room_id VARCHAR
            )
        `);

        // Migration: Ensure room_id exists
        const tableSchemaResult = await runQuery("PRAGMA table_info('messages')");
        const tableSchema = await tableSchemaResult;
        const columns = tableSchema.toArray().map(r => r.toJSON().name);
        if (!columns.includes('room_id')) {
            await runQuery(`ALTER TABLE messages ADD COLUMN room_id VARCHAR`);
        }
    } catch (error) {
        console.error('❌ Failed to initialize DuckDB:', error);
    }
};

export const saveMessageLocally = async (id, sender, content, timestamp, room_id) => {
    if (!conn) return;
    try {
        const safeContent = content.replace(/'/g, "''"); 
        const safeRoomId = room_id ? room_id.replace(/'/g, "''") : 'unknown';
        await runQuery(`
            INSERT INTO messages (id, sender, content, timestamp, room_id) 
            VALUES ('${id}', '${sender}', '${safeContent}', ${timestamp}, '${safeRoomId}')
        `);
        console.log(`💾 Saved message to DuckDB (room: ${room_id})`);
    } catch (error) {
        console.error('❌ Failed to save message:', error);
    }
};

export const getMessagesLocally = async (room_id) => {
    if (!conn) return [];
    try {
        let queryStr = 'SELECT * FROM messages';
        if (room_id) {
            queryStr += ` WHERE room_id = '${room_id.replace(/'/g, "''")}'`;
        }
        queryStr += ' ORDER BY timestamp ASC';
        
        const resultPromise = runQuery(queryStr);
        const result = await resultPromise;
        const rows = result.toArray().map(row => {
            const data = row.toJSON();
            if (typeof data.timestamp === 'bigint') {
                data.timestamp = Number(data.timestamp);
            }
            return data;
        });
        console.log(`📂 Fetched ${rows.length} messages from DuckDB${room_id ? ' for room ' + room_id : ' (Global)'}`);
        return rows;
    } catch (error) {
        console.error('❌ Failed to get messages:', error);
        return [];
    }
};

export const getAllHistory = async () => {
    return getMessagesLocally();
};

export const clearHistory = async () => {
    if (!conn) return;
    try {
        await runQuery('DELETE FROM messages');
        console.log('🗑️ Local chat history cleared');
    } catch (error) {
        console.error('❌ Failed to clear history:', error);
    }
};

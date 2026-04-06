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

export const initDB = async () => {
    if (db) return;

    try {
        const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
        const worker = new Worker(bundle.mainWorker);
        const logger = new duckdb.ConsoleLogger();
        db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        conn = await db.connect();
        
        // Create messages table
        // We use an in-memory database by default here.
        await conn.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id VARCHAR PRIMARY KEY,
                sender VARCHAR,
                content TEXT,
                timestamp BIGINT
            )
        `);
        console.log('✅ DuckDB WASM Initialized');
    } catch (error) {
        console.error('❌ Failed to initialize DuckDB:', error);
    }
};

export const saveMessageLocally = async (id, sender, content, timestamp) => {
    if (!conn) return;
    try {
        const safeContent = content.replace(/'/g, "''"); // Basic escape for single quotes
        await conn.query(`
            INSERT INTO messages (id, sender, content, timestamp) 
            VALUES ('${id}', '${sender}', '${safeContent}', ${timestamp})
        `);
    } catch (error) {
        console.error('❌ Failed to save message:', error);
    }
};

export const getMessagesLocally = async () => {
    if (!conn) return [];
    try {
        const result = await conn.query('SELECT * FROM messages ORDER BY timestamp ASC');
        return result.toArray().map(row => row.toJSON());
    } catch (error) {
        console.error('❌ Failed to get messages:', error);
        return [];
    }
};

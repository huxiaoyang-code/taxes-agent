// W2a owner-only protocol. Durable facts remain in SQLite; execution authority is private.
export {prepareOperation,executePreparedOperation,queryOperation} from './local-audit-storage.mjs';

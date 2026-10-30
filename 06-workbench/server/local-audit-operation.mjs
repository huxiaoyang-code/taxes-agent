// W2a 仅限所有者的协议。持久化事实保存在 SQLite，执行权限保持私有。
export {prepareOperation,executePreparedOperation,executePreparedChild,bindPreparedChildren,queryOperation} from './local-audit-storage.mjs';

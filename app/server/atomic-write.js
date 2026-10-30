// 原子写 JSON 文件（写临时文件 + rename）。
//
// 关键点：临时文件名必须唯一，且同一个目标文件要串行写。
// 以前各模块用固定的 `<file>.tmp`：
//   A 写完 tmp → B 覆盖同一个 tmp → A rename 成功 → B rename 报 ENOENT。
// 表现是接口 500 丢写（trays.json），或者只是一个「不影响内存缓存」的告警（vscm）。
// 更隐蔽的是顺序颠倒时，旧快照会把新快照盖掉。
//
// 同一目标文件的写排队执行，保证最后发起的那次写就是最终落盘的版本。

import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

// 临时文件名里的自增序号（与 pid 一起，保证同一进程内并发也不撞名）
let seq = 0;

// 每个目标文件一条队列：读写顺序确定，失败也不会卡死后面
const chains = new Map();

function enqueue(file, task) {
  const prev = chains.get(file) || Promise.resolve();
  const run = prev.then(task);
  chains.set(file, run.then(() => {}, () => {}));
  return run;
}

/**
 * 把 value 序列化成 JSON 原子写入 file。
 * 失败时清理临时文件，并把错误抛给调用方。
 */
export function writeJsonAtomic(file, value) {
  return enqueue(file, async () => {
    const tmp = `${file}.${process.pid}.${++seq}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(tmp, JSON.stringify(value), 'utf8');
      await rename(tmp, file);
    } catch (err) {
      unlink(tmp).catch(() => {}); // 写一半失败别留下垃圾临时文件
      throw err;
    }
  });
}

// 同一货盘的在线成员
// 服务端推的是「房间里的所有连接」：同一个人开两个标签页会出现两次，自己的连接也在里面。
// 这里去重并去掉自己，只留下「还有谁在看这个货盘」。只读账号也在里面（他们看得到、但改不了）。
export interface RoomUser {
  name: string;
  canEdit: boolean;
}

export function roomOthers(users: unknown, self: string): RoomUser[] {
  const list = Array.isArray(users) ? users : [];
  const out: RoomUser[] = [];
  const index = new Map<string, number>();
  const me = String(self || '').trim();
  for (const u of list) {
    // 兼容老格式（纯字符串）与新格式（{ name, canEdit }）
    let name = '';
    let canEdit = true;
    if (typeof u === 'string') {
      name = u.trim();
    } else if (u && typeof u === 'object') {
      const obj = u as { name?: unknown; canEdit?: unknown };
      name = typeof obj.name === 'string' ? obj.name.trim() : '';
      canEdit = obj.canEdit !== false;
    }
    if (!name || name === me) continue;
    const at = index.get(name);
    if (at === undefined) {
      index.set(name, out.length);
      out.push({ name, canEdit });
    } else if (canEdit) {
      // 同一个人开了两个标签页：只要有一个能编辑，就算能编辑
      out[at] = { name, canEdit: true };
    }
  }
  return out;
}

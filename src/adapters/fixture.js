/**
 * 假数据源：完全不碰微信，用于端到端验证整条链路。
 *
 * 数据集里故意同时放一个群和一个私聊，并且各埋一条哨兵字符串：
 * 群哨兵应出现在摘要里（阳性对照），私聊哨兵必须零出现。
 */

export const GROUP_SENTINEL = 'GRP-DEMO-5f2c1a9e';
export const PRIVATE_SENTINEL = 'PRIV-DEMO-9b7d3e01';

export function createFixtureAdapter(dataset = DEFAULT_FIXTURE) {
  return {
    name: 'fixture',
    async listRooms() {
      return dataset.rooms.map((room) => ({ ...room }));
    },
    async fetchMessages({ room, fromSeq = 0 }) {
      const all = dataset.messagesByRoom[room.rawId] ?? [];
      return all.filter((message) => message.seq > fromSeq).map((message) => ({ ...message }));
    },
  };
}

export const DEFAULT_FIXTURE = {
  rooms: [
    { rawId: '12345678@chatroom', name: '产品评审群', authoritativeKind: 'group' },
    { rawId: 'wxid_demo111111', name: '某人', authoritativeKind: 'private' },
    { rawId: 'gh_demo123456', name: '某公众号', authoritativeKind: 'excluded' },
  ],
  messagesByRoom: {
    '12345678@chatroom': [
      { seq: 1, at: '2026-11-10T08:00:00+08:00', sender: '小王', text: `周五前把评审稿交上来，${GROUP_SENTINEL}` },
      { seq: 2, at: '2026-11-10T08:05:00+08:00', sender: '老李', text: '待办：确认服务器预算，截止周三' },
      { seq: 3, at: '2026-11-10T08:09:00+08:00', sender: '小张', text: '@小王 数据口径按上周定的来' },
      { seq: 4, at: '2026-11-10T08:12:00+08:00', sender: '小王', text: '收到，我今天下午对齐一下' },
    ],
    'wxid_demo111111': [
      // 这条带"待办"关键词，所以开关打开时会真的被摘要收录——
      // 这样双哨兵在两个方向上都能验证：关着时零出现，打开时确实出现。
      { seq: 1, at: '2026-11-10T08:03:00+08:00', sender: '某人', text: `待办：私下约个时间 ${PRIVATE_SENTINEL}` },
    ],
    'gh_demo123456': [
      { seq: 1, at: '2026-11-10T08:04:00+08:00', sender: '公众号', text: '今日推送' },
    ],
  },
};

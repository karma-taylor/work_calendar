const day = (offset) => {
  const value = new Date()
  value.setHours(0, 0, 0, 0)
  value.setDate(value.getDate() + offset)
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const date = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${date}`
}

// All values in this file are fictional portfolio data. They must never be
// replaced with roster exports, client names, or personally identifying data.
export const demoStaff = {
  managers: [
    { id: 'demo-manager-1', name: '林远航', title: '项目经理', tradeTag: '项目经理', sourceSheet: '云峰工程' },
    { id: 'demo-manager-2', name: '周知行', title: '现场主管', tradeTag: '现场主管', sourceSheet: '蓝湾项目部' },
  ],
  workers: [
    { id: 'demo-worker-1', name: '沈星河', title: '电工', tradeTag: '电工', sourceSheet: '海桥机电' },
    { id: 'demo-worker-2', name: '许明澈', title: '焊工', tradeTag: '焊工', sourceSheet: '云峰工程' },
    { id: 'demo-worker-3', name: '程叙白', title: '管工', tradeTag: '管工', sourceSheet: '海桥机电' },
    { id: 'demo-worker-4', name: '陆青川', title: '起重工', tradeTag: '起重工', sourceSheet: '蓝湾项目部' },
  ],
}

export const demoProjects = [
  {
    id: 'demo-project-a',
    name: '滨江机房改造（演示）',
    startDate: day(-3),
    endDate: day(4),
    managerIds: ['demo-manager-1'],
    workerIds: ['demo-worker-1', 'demo-worker-2'],
    managerEnabled: true,
    workerEnabled: true,
    assignments: [
      { id: 'demo-a-manager', personId: 'demo-manager-1', role: 'manager', trade: '', segmentStart: day(-3), segmentEnd: day(4), note: '虚构演示数据' },
      { id: 'demo-a-electrician', personId: 'demo-worker-1', role: 'worker', trade: '电工', segmentStart: day(-2), segmentEnd: day(3), note: '' },
      { id: 'demo-a-welder', personId: 'demo-worker-2', role: 'worker', trade: '焊工', segmentStart: day(-1), segmentEnd: day(4), note: '' },
    ],
  },
  {
    id: 'demo-project-b',
    name: '东区管线巡检（演示）',
    startDate: day(6),
    endDate: day(11),
    managerIds: ['demo-manager-2'],
    workerIds: ['demo-worker-3', 'demo-worker-4'],
    managerEnabled: true,
    workerEnabled: true,
    assignments: [
      { id: 'demo-b-manager', personId: 'demo-manager-2', role: 'manager', trade: '', segmentStart: day(6), segmentEnd: day(11), note: '虚构演示数据' },
      { id: 'demo-b-pipefitter', personId: 'demo-worker-3', role: 'worker', trade: '管工', segmentStart: day(6), segmentEnd: day(10), note: '' },
      { id: 'demo-b-rigger', personId: 'demo-worker-4', role: 'worker', trade: '起重工', segmentStart: day(8), segmentEnd: day(11), note: '' },
    ],
  },
]

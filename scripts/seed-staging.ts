import { faker } from '@faker-js/faker'

type Staff = { id: string; name: string; title: string; tradeTag: string; sourceSheet: string }
type Assignment = { id: string; personId: string; role: 'manager' | 'worker'; trade: string; segmentStart: string; segmentEnd: string; note: string }
type Project = { id: string; name: string; startDate: string; endDate: string; assignments: Assignment[]; managerIds: string[]; workerIds: string[]; managerEnabled: boolean; workerEnabled: boolean }

const apiUrl = process.env.WORK_CALENDAR_API_URL?.replace(/\/$/, '')
const apiKey = process.env.WORK_CALENDAR_API_KEY
const apiKeyId = process.env.WORK_CALENDAR_API_KEY_ID
const stagingRef = process.env.WORK_CALENDAR_STAGING_PROJECT_REF ?? 'djnknltowfrenlyjbvad'
const shouldApply = process.argv.includes('--apply')
const baseDate = process.env.WORK_CALENDAR_SEED_DATE ?? '2026-09-01'
const sources = ['江都', '省建', '科林'] as const
const managerSources = ['江都', '省建', '科林', 'CSI'] as const
const trades = ['电工', '焊工', '管工', '起重工'] as const
const surnames = [...'赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳谢宋唐费罗毕安乐傅伍余孟黄穆萧姚邵汪祁毛龙叶白林徐高夏蔡田胡凌霍万柯卢莫温柴庄晏']
const givenA = [...'华明强志宇晨文浩子俊博天嘉安泽瑞德海振凯宁轩远']
const givenB = [...'强宇晨博宁远涵航泽然轩毅涛阳林昊睿彬辰骏翔铭']

function fail(message: string): never { throw new Error(message) }
function iso(date: Date) { return date.toISOString().slice(0, 10) }
function plusDays(date: string, days: number) { const next = new Date(`${date}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + days); return iso(next) }
function requireStaging() {
  if (!apiUrl || !apiKey || !apiKeyId) fail('Set WORK_CALENDAR_API_URL, WORK_CALENDAR_API_KEY, and WORK_CALENDAR_API_KEY_ID.')
  const host = new URL(apiUrl).hostname
  if (process.env.WORK_CALENDAR_STAGE !== 'staging' || !host.startsWith(`${stagingRef}.supabase.co`)) {
    fail('Refusing to seed: set WORK_CALENDAR_STAGE=staging and use the exact staging project URL.')
  }
}
async function request<T>(action: string, payload: Record<string, unknown> = {}) {
  const response = await fetch(apiUrl!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173', 'x-work-calendar-key': apiKey!, 'x-work-calendar-key-id': apiKeyId! },
    body: JSON.stringify({ action, ...payload }),
  })
  const result = await response.json() as T & { error?: string }
  if (!response.ok) fail(`${action} failed: ${result.error ?? response.status}`)
  return result
}
function alias(index: number) { return `${surnames[index % surnames.length]}${givenA[Math.floor(index / surnames.length) % givenA.length]}${givenB[Math.floor(index / (surnames.length * givenA.length)) % givenB.length]}` }
function makeStaff() {
  faker.seed(20260827)
  const managers: Staff[] = Array.from({ length: 6 }, (_, index) => ({
    id: `staff-seed-manager-${String(index + 1).padStart(2, '0')}`,
    name: alias(index), title: faker.helpers.arrayElement(['项目经理', '现场主管']), tradeTag: '项目管理', sourceSheet: faker.helpers.arrayElement(managerSources),
  }))
  const workers: Staff[] = Array.from({ length: 44 }, (_, index) => {
    const tradeTag = trades[index % trades.length]
    return { id: `staff-seed-worker-${String(index + 1).padStart(2, '0')}`, name: alias(index + managers.length), title: tradeTag, tradeTag, sourceSheet: faker.helpers.arrayElement(sources) }
  })
  return { managers, workers }
}
function makeProjects(staff: ReturnType<typeof makeStaff>) {
  const projects: Project[] = []
  for (let index = 0; index < 12; index += 1) {
    const startDate = plusDays(baseDate, index * 4)
    const endDate = plusDays(startDate, 2)
    const manager = staff.managers[index % staff.managers.length]
    const selectedWorkers = Array.from({ length: 6 }, (_, offset) => staff.workers[(index * 7 + offset) % staff.workers.length])
    const assignments: Assignment[] = [
      { id: `seed-shift-${String(index + 1).padStart(2, '0')}-manager`, personId: manager.id, role: 'manager', trade: manager.tradeTag, segmentStart: startDate, segmentEnd: endDate, note: '虚构 staging 负责人' },
      ...selectedWorkers.map((worker, offset) => ({ id: `seed-shift-${String(index + 1).padStart(2, '0')}-worker-${offset + 1}`, personId: worker.id, role: 'worker' as const, trade: worker.tradeTag, segmentStart: startDate, segmentEnd: endDate, note: `虚构 ${worker.tradeTag} 班次` })),
    ]
    projects.push({ id: `seed-project-${String(index + 1).padStart(2, '0')}`, name: `Staging 虚构项目 ${String(index + 1).padStart(2, '0')}`, startDate, endDate, assignments, managerIds: [manager.id], workerIds: selectedWorkers.map(({ id }) => id), managerEnabled: true, workerEnabled: true })
  }
  return projects
}

requireStaging()
const state = await request<{ projects: Project[]; staff: { managers: Staff[]; workers: Staff[] }; revision: string | null; staffRevision: string | null }>('read', { scope: { full: true } })
const seedStaff = makeStaff()
const seedProjects = makeProjects(seedStaff)
const existingPeople = [...state.staff.managers, ...state.staff.workers]
const seedPeoplePresent = existingPeople.filter((person) => person.id.startsWith('staff-seed-')).length
const nonSeedPeoplePresent = existingPeople.length - seedPeoplePresent
const missingProjects = seedProjects.filter((project) => !state.projects.some((existing) => existing.id === project.id))

console.log(JSON.stringify({ stage: 'staging', apply: shouldApply, staffToCreate: existingPeople.length ? 0 : 50, projectsToCreate: missingProjects.length, conflictFixture: 'Use a seeded shift window with another worker of the same trade; the API must reject it as SCHEDULING_CONFLICT.', revisionMismatchFixture: 'Apply a valid Patch twice with its original expectedRevision; the second call must return REVISION_MISMATCH.' }, null, 2))
if (!shouldApply) process.exit(0)
if (nonSeedPeoplePresent > 0 && seedPeoplePresent === 0) fail('Refusing to replace a non-empty non-seed roster. Use a fresh staging project.')

let staffRevision = state.staffRevision
if (!existingPeople.length) {
  const applied = await request<{ revision: string }>('apply_staff', { staff: seedStaff, expectedRevision: staffRevision })
  staffRevision = applied.revision
}

let revision = state.revision
for (const project of missingProjects) {
  const applied = await request<{ revision: string }>('create_project', { project, expectedRevision: revision })
  if (!applied.revision) fail(`create_project returned no revision for ${project.id}. Refusing to continue with an unreliable staging write.`)
  revision = applied.revision
}
const verified = await request<{ projects: Project[] }>('read', { scope: { full: true } })
const seededProjectCount = verified.projects.filter((project) => project.id.startsWith('seed-project-')).length
if (seededProjectCount !== seedProjects.length) fail(`Seed verification failed: expected ${seedProjects.length} projects, found ${seededProjectCount}.`)
console.log(JSON.stringify({ ok: true, createdStaff: existingPeople.length ? 0 : 50, createdProjects: missingProjects.length, seededProjectCount, projectRevision: revision, staffRevision }, null, 2))

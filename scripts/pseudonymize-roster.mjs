import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import XLSX from 'xlsx'

const source = path.resolve(process.cwd(), '人员名单.xlsx')
const backupDir = '/Users/taylorkarma/Documents/ai/work-calendar-private'
const passphrase = process.env.PSEUDONYM_BACKUP_PASSPHRASE
if (!passphrase) throw new Error('Set PSEUDONYM_BACKUP_PASSPHRASE before running this one-time migration.')
const targetSheets = new Set(['江都', '省建', '科林'])
const isCsi = (name) => ['csi', 'csisheet', 'csi sheet'].includes(String(name).trim().toLowerCase())
const normalize = (value) => String(value ?? '').trim()
const surnames = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房裘缪干解应宗丁宣邓单杭洪包诸左石崔吉龚程嵇邢滑裴陆荣翁荀羊於惠甄魏家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴郁胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍却璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公'.split('')
const givenA = '华明强志宇晨文浩子俊博天嘉安泽瑞德海振凯宁轩远'.split('')
const givenB = '强宇晨博宁远涵航泽然轩毅涛阳林昊睿彬辰骏翔铭'.split('')
const encrypt = (buffer) => { const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12); const key = crypto.scryptSync(passphrase, salt, 32); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(buffer), cipher.final()]); return Buffer.concat([Buffer.from('WC1'), salt, iv, cipher.getAuthTag(), data]) }

await fs.mkdir(backupDir, { recursive: true, mode: 0o700 })
const original = await fs.readFile(source)
const workbook = XLSX.read(original, { type: 'buffer', cellStyles: true })
const people = []
for (const sheetName of workbook.SheetNames) {
  if (!targetSheets.has(sheetName) && !isCsi(sheetName)) continue
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' })
  for (let rowIndex = 2; rowIndex < rows.length; rowIndex += 1) {
    const name = normalize((rows[rowIndex] || [])[2]); if (!name) continue
    people.push({ sheetName, row: rowIndex + 1, originalName: name, alias: '', id: `staff-${String(people.length + 1).padStart(3, '0')}` })
  }
}
const used = new Set()
people.forEach((person, index) => { for (let n = index; ; n += 1) { const alias = `${surnames[n % surnames.length]}${givenA[Math.floor(n / surnames.length) % givenA.length]}${givenB[Math.floor(n / (surnames.length * givenA.length)) % givenB.length]}`; if (!used.has(alias)) { used.add(alias); person.alias = alias; break } } })
const aliases = new Map(people.map((person) => [person.originalName, person.alias]))
for (const sheetName of workbook.SheetNames) {
  const sheet = workbook.Sheets[sheetName]
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!') || typeof sheet[address]?.v !== 'string') continue
    let next = sheet[address].v
    for (const [realName, alias] of aliases) next = next.replaceAll(realName, alias)
    if (next !== sheet[address].v) { sheet[address].v = next; sheet[address].w = next }
  }
}
await fs.writeFile(path.join(backupDir, '人员名单.original.xlsx.enc'), encrypt(original), { mode: 0o600 })
await fs.writeFile(path.join(backupDir, 'pseudonym-map.json.enc'), encrypt(Buffer.from(JSON.stringify(people, null, 2))), { mode: 0o600 })
XLSX.writeFile(workbook, source, { bookType: 'xlsx', compression: true })
console.log(JSON.stringify({ anonymizedPeople: people.length, backupDir, people: people.map(({ sheetName, row, alias, id }) => ({ sheetName, row, alias, id })) }))

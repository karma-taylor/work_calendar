import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react'
import './App.css'
import {
  isCloudEnabled,
  loadProjectsFromCloud,
  loadStaffFromCloud,
  saveProjectsToCloud,
  saveStaffToCloud,
} from './lib/cloudStore'

const TARGET_SHEETS = new Set(['江都', '省建', '科林'])
const normalize = (value) => String(value ?? '').trim()
/** CSI 工作表内人员一律按管理人员处理（仍读 C 列姓名、F 列岗位） */
const isCsiStaffSheet = (sheetName) => {
  const n = normalize(sheetName).toLowerCase()
  return n === 'csi' || n === 'csisheet' || n === 'csi sheet'
}
const START_ROW_INDEX = 2
const PROJECTS_STORAGE_KEY = 'work-calendar-projects-v1'
/** 人员名单解析结果 + 是否曾选择「锁定」——刷新后必能恢复，不依赖文件句柄权限 */
const STAFF_CACHE_KEY = 'work-calendar-staff-cache-v2'

function readStaffCache() {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(STAFF_CACHE_KEY)
    if (!raw) {
      return null
    }
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.managers) || !Array.isArray(data.workers)) {
      return null
    }
    return {
      managers: data.managers,
      workers: data.workers,
      staffFileName: typeof data.staffFileName === 'string' ? data.staffFileName : '',
      lockIntent: Boolean(data.lockIntent),
    }
  } catch {
    return null
  }
}

const STAFF_DB_NAME = 'work-calendar-db-v1'
const STAFF_STORE = 'meta'
const STAFF_HANDLE_KEY = 'staff-excel-handle'

const openStaffDB = () =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(STAFF_DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STAFF_STORE)) {
        req.result.createObjectStore(STAFF_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const idbGetStaffHandle = async () => {
  const db = await openStaffDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STAFF_STORE, 'readonly')
    const request = tx.objectStore(STAFF_STORE).get(STAFF_HANDLE_KEY)
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(request.error)
  })
}

const idbSetStaffHandle = async (handle) => {
  const db = await openStaffDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STAFF_STORE, 'readwrite')
    tx.objectStore(STAFF_STORE).put(handle, STAFF_HANDLE_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

const idbClearStaffHandle = async () => {
  const db = await openStaffDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STAFF_STORE, 'readwrite')
    tx.objectStore(STAFF_STORE).delete(STAFF_HANDLE_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

const supportsFilePicker = () => typeof window !== 'undefined' && 'showOpenFilePicker' in window

const today = new Date()

const toInputDate = (date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const buildMonthDays = (year, month) => {
  const firstDay = new Date(year, month, 1)
  const firstWeekday = (firstDay.getDay() + 6) % 7
  const startDate = new Date(year, month, 1 - firstWeekday)
  const days = []

  for (let i = 0; i < 42; i += 1) {
    const current = new Date(startDate)
    current.setDate(startDate.getDate() + i)
    days.push({
      key: toInputDate(current),
      date: current,
      inCurrentMonth: current.getMonth() === month,
    })
  }

  return days
}

const getDisplayName = (list, ids) =>
  ids
    .map((id) => {
      const person = list.find((item) => item.id === id)
      return person ? `${person.name}(${person.sourceSheet})` : ''
    })
    .filter(Boolean)
    .join(', ')

const MS_PER_DAY = 24 * 60 * 60 * 1000

const toDayStart = (dateValue) => {
  const date = new Date(dateValue)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

const dayDiff = (a, b) => Math.round((toDayStart(a) - toDayStart(b)) / MS_PER_DAY)
const personUniqueKey = (person) => `${person.name}@@${person.sourceSheet}`

const readFileWithProgress = (file, onProgress) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.onprogress = (event) => {
      if (event.lengthComputable && typeof onProgress === 'function') {
        const percent = Math.min(95, Math.round((event.loaded / event.total) * 95))
        onProgress(percent)
      }
    }
    reader.readAsArrayBuffer(file)
  })

const parseStaffBuffer = async (buffer) => {
  const xlsxMod = await import('xlsx')
  const XLSX = xlsxMod.default ?? xlsxMod
  const workbook = XLSX.read(buffer, { type: 'array' })
  const managers = []
  const workers = []

  workbook.SheetNames.forEach((sheetName) => {
    if (!TARGET_SHEETS.has(sheetName) && !isCsiStaffSheet(sheetName)) {
      return
    }
    const sheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: '',
    })
    for (let rowIndex = START_ROW_INDEX; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] || []
      const name = normalize(row[2])
      const title = normalize(row[5])
      if (!name) {
        continue
      }
      const item = {
        id: `${sheetName}-${rowIndex + 1}-${name}-${title || '未知岗位'}`,
        name,
        title,
        sourceSheet: sheetName,
      }
      if (isCsiStaffSheet(sheetName)) {
        managers.push(item)
      } else if (title.includes('工')) {
        workers.push(item)
      } else {
        managers.push(item)
      }
    }
  })

  return { managers, workers }
}

const hasDateOverlap = (startA, endA, startB, endB) => {
  const aStart = toDayStart(startA)
  const aEnd = toDayStart(endA)
  const bStart = toDayStart(startB)
  const bEnd = toDayStart(endB)
  return aStart <= bEnd && bStart <= aEnd
}

function App() {
  const [currentYear, setCurrentYear] = useState(today.getFullYear())
  const [currentMonth, setCurrentMonth] = useState(today.getMonth())
  const [managers, setManagers] = useState(() => readStaffCache()?.managers ?? [])
  const [workers, setWorkers] = useState(() => readStaffCache()?.workers ?? [])
  const [staffFileName, setStaffFileName] = useState(() => readStaffCache()?.staffFileName ?? '')
  /** 与本地 Excel 的锁定关系（含缓存的「曾锁定」状态，刷新后从 localStorage 恢复） */
  const [staffFileLocked, setStaffFileLocked] = useState(() => readStaffCache()?.lockIntent ?? false)
  /** 曾锁定但 IndexedDB 句柄失效或权限未通过：名单仍来自缓存，需重新选文件才能自动跟文件同步 */
  const [staffNeedRelink, setStaffNeedRelink] = useState(false)
  const staffHandleRef = useRef(null)
  const staffLastModifiedRef = useRef(0)
  const [staffPollEnabled, setStaffPollEnabled] = useState(false)
  const [projects, setProjects] = useState([])
  /** 避免首屏用空数组覆盖 localStorage（必须在读完缓存后才允许写入） */
  const [projectsHydrated, setProjectsHydrated] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [selectedProject, setSelectedProject] = useState(null)
  /** 开启后点击日历工单条可删除工单 */
  const [deleteMode, setDeleteMode] = useState(false)
  const [form, setForm] = useState({
    name: '',
    startDate: toInputDate(today),
    endDate: toInputDate(today),
    managerEnabled: false,
    workerEnabled: false,
    managerIds: [],
    workerIds: [],
  })

  const applyStaffResult = useCallback((result, fileName) => {
    if (!result || !Array.isArray(result.managers) || !Array.isArray(result.workers)) {
      console.error('人员名单解析结果异常', result)
      window.alert('人员名单解析结果异常，请重试或检查 Excel。')
      return
    }
    setManagers(result.managers)
    setWorkers(result.workers)
    setStaffFileName(fileName)
    setForm((prev) => ({
      ...prev,
      managerIds: prev.managerIds.filter((id) =>
        result.managers.some((manager) => manager.id === id),
      ),
      workerIds: prev.workerIds.filter((id) =>
        result.workers.some((worker) => worker.id === id),
      ),
    }))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed) && !cancelled) {
            setProjects(parsed)
          }
        }
      } catch (error) {
        console.error('读取项目缓存失败', error)
      }

      if (isCloudEnabled()) {
        try {
          const cloudProjects = await loadProjectsFromCloud()
          if (Array.isArray(cloudProjects) && !cancelled) {
            setProjects(cloudProjects)
          }
        } catch (error) {
          console.error('读取云端工单失败', error)
        }
      }

      if (!cancelled) {
        setProjectsHydrated(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!projectsHydrated) {
      return
    }
    try {
      window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects))
    } catch (error) {
      console.error('保存项目缓存失败', error)
    }
    if (isCloudEnabled()) {
      void saveProjectsToCloud(projects).catch((error) => {
        console.error('保存云端工单失败', error)
      })
    }
  }, [projects, projectsHydrated])

  /** 人员名单持久化：刷新即可恢复，不依赖文件系统 API 权限 */
  useEffect(() => {
    try {
      window.localStorage.setItem(
        STAFF_CACHE_KEY,
        JSON.stringify({
          managers,
          workers,
          staffFileName,
          lockIntent: staffFileLocked,
        }),
      )
    } catch (error) {
      if (error?.name === 'QuotaExceededError') {
        window.alert(
          '人员名单数据超出浏览器存储上限，无法完整保存。请缩小 Excel 行数或清理本站数据后重试。',
        )
      }
      console.error('保存人员名单缓存失败', error)
    }
    if (isCloudEnabled()) {
      void saveStaffToCloud({
        managers,
        workers,
        staffFileName,
        lockIntent: staffFileLocked,
      }).catch((error) => {
        console.error('保存云端人员名单失败', error)
      })
    }
  }, [managers, workers, staffFileName, staffFileLocked])

  /** 云端人员名单恢复（若存在云端数据，优先覆盖本地缓存） */
  useEffect(() => {
    if (!isCloudEnabled()) {
      return undefined
    }
    let cancelled = false
    void (async () => {
      try {
        const cloudStaff = await loadStaffFromCloud()
        if (
          !cancelled &&
          cloudStaff &&
          Array.isArray(cloudStaff.managers) &&
          Array.isArray(cloudStaff.workers)
        ) {
          applyStaffResult(cloudStaff, cloudStaff.staffFileName || '云端名单')
          setStaffFileLocked(Boolean(cloudStaff.lockIntent))
        }
      } catch (error) {
        console.error('读取云端人员名单失败', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applyStaffResult])

  /** 从 IndexedDB 恢复上次锁定的 Excel 文件句柄（用于检测磁盘文件是否更新；失败时仍保留 localStorage 中的名单） */
  useEffect(() => {
    if (!('indexedDB' in window)) {
      return undefined
    }
    let cancelled = false
    void (async () => {
      try {
        const handle = await idbGetStaffHandle()
        if (!handle || cancelled) {
          const cached = readStaffCache()
          if (cached?.lockIntent) {
            setStaffNeedRelink(true)
          }
          return
        }
        let perm = await handle.queryPermission({ mode: 'read' })
        if (perm !== 'granted') {
          perm = await handle.requestPermission({ mode: 'read' })
        }
        if (perm !== 'granted' || cancelled) {
          const cached = readStaffCache()
          if (cached?.lockIntent) {
            setStaffNeedRelink(true)
          }
          return
        }
        staffHandleRef.current = handle
        const file = await handle.getFile()
        const buffer = await file.arrayBuffer()
        const result = await parseStaffBuffer(buffer)
        if (cancelled) {
          return
        }
        staffLastModifiedRef.current = file.lastModified
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            startTransition(() => {
              applyStaffResult(result, file.name)
              setStaffFileLocked(true)
              setStaffPollEnabled(true)
              setStaffNeedRelink(false)
            })
          })
        })
      } catch (error) {
        console.error('恢复锁定的人员名单失败', error)
        const cached = readStaffCache()
        if (cached?.lockIntent) {
          setStaffNeedRelink(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [applyStaffResult])

  /** 轮询同一文件是否被覆盖保存，变更后自动重新解析（每次从 ref 读句柄，避免「更换锁定」后仍用旧句柄） */
  useEffect(() => {
    if (!staffPollEnabled) {
      return undefined
    }

    const checkUpdate = async () => {
      const handle = staffHandleRef.current
      if (!handle) {
        return
      }
      try {
        const perm = await handle.queryPermission({ mode: 'read' })
        if (perm !== 'granted') {
          return
        }
        const file = await handle.getFile()
        if (file.lastModified === staffLastModifiedRef.current) {
          return
        }
        staffLastModifiedRef.current = file.lastModified
        const buffer = await file.arrayBuffer()
        const result = await parseStaffBuffer(buffer)
        requestAnimationFrame(() => {
          startTransition(() => {
            applyStaffResult(result, file.name)
          })
        })
      } catch (error) {
        console.error('检测人员名单更新失败', error)
      }
    }

    const intervalId = window.setInterval(() => {
      void checkUpdate()
    }, 8000)
    const onFocus = () => {
      void checkUpdate()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void checkUpdate()
      }
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    void checkUpdate()

    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [staffPollEnabled, applyStaffResult])

  const days = useMemo(
    () => buildMonthDays(currentYear, currentMonth),
    [currentMonth, currentYear],
  )
  const monthTitle = `${currentYear}年 ${currentMonth + 1}月`
  const weekdayHeaders = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  const weeks = useMemo(
    () => Array.from({ length: 6 }, (_, index) => days.slice(index * 7, index * 7 + 7)),
    [days],
  )

  const togglePerson = (field, id) => {
    setForm((prev) => {
      const exists = prev[field].includes(id)
      return {
        ...prev,
        [field]: exists ? prev[field].filter((item) => item !== id) : [...prev[field], id],
      }
    })
  }

  const closeModal = () => {
    setShowModal(false)
    setForm({
      name: '',
      startDate: toInputDate(today),
      endDate: toInputDate(today),
      managerEnabled: false,
      workerEnabled: false,
      managerIds: [],
      workerIds: [],
    })
  }

  const submitProject = (event) => {
    event.preventDefault()
    if (!form.name.trim()) {
      window.alert('请填写项目名称')
      return
    }
    if (form.startDate > form.endDate) {
      window.alert('结束日期不能早于开始日期')
      return
    }
    if (form.managerEnabled && form.managerIds.length === 0) {
      window.alert('请至少选择一位管理人员')
      return
    }
    if (form.workerEnabled && form.workerIds.length === 0) {
      window.alert('请至少选择一位工人')
      return
    }

    const peopleById = new Map(
      [...managers, ...workers].map((person) => [person.id, person]),
    )
    const currentPeople = new Set(
      [...form.managerIds, ...form.workerIds]
        .map((id) => peopleById.get(id))
        .filter(Boolean)
        .map(personUniqueKey),
    )

    const conflictProject = projects.find((project) => {
      if (!hasDateOverlap(form.startDate, form.endDate, project.startDate, project.endDate)) {
        return false
      }
      const projectPeople = new Set(
        [...project.managerIds, ...project.workerIds]
          .map((id) => peopleById.get(id))
          .filter(Boolean)
          .map(personUniqueKey),
      )
      return [...currentPeople].some((key) => projectPeople.has(key))
    })

    if (conflictProject) {
      const projectPeople = new Set(
        [...conflictProject.managerIds, ...conflictProject.workerIds]
          .map((id) => peopleById.get(id))
          .filter(Boolean)
          .map(personUniqueKey),
      )
      const conflictedNames = [...currentPeople]
        .filter((key) => projectPeople.has(key))
        .map((key) => key.replace('@@', '(') + ')')
      window.alert(
        `人员冲突：${conflictedNames.join('、')} 在同时间已分配到项目「${conflictProject.name}」，一个人不能同时参与两个项目。`,
      )
      return
    }

    setProjects((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        ...form,
      },
    ])
    closeModal()
  }

  const changeMonth = (offset) => {
    const next = new Date(currentYear, currentMonth + offset, 1)
    setCurrentYear(next.getFullYear())
    setCurrentMonth(next.getMonth())
  }

  const getWeekSegments = (week) => {
    const weekStart = toDayStart(week[0].date)
    const weekEnd = toDayStart(week[6].date)
    const intersected = projects
      .filter((project) => {
        const projectStart = toDayStart(project.startDate)
        const projectEnd = toDayStart(project.endDate)
        return projectStart <= weekEnd && projectEnd >= weekStart
      })
      .map((project) => {
        const projectStart = toDayStart(project.startDate)
        const projectEnd = toDayStart(project.endDate)
        const visibleStart = projectStart > weekStart ? projectStart : weekStart
        const visibleEnd = projectEnd < weekEnd ? projectEnd : weekEnd
        return {
          project,
          startIndex: dayDiff(visibleStart, weekStart),
          endIndex: dayDiff(visibleEnd, weekStart),
          continuedFromPrev: projectStart < weekStart,
          continuedToNext: projectEnd > weekEnd,
        }
      })
      .sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)

    const lanes = []
    return intersected.map((segment) => {
      let laneIndex = lanes.findIndex((lastEnd) => segment.startIndex > lastEnd)
      if (laneIndex === -1) {
        laneIndex = lanes.length
        lanes.push(segment.endIndex)
      } else {
        lanes[laneIndex] = segment.endIndex
      }
      return { ...segment, lane: laneIndex, span: segment.endIndex - segment.startIndex + 1 }
    })
  }

  const pickLockStaffFile = async () => {
    if (!supportsFilePicker()) {
      window.alert(
        '当前浏览器不支持“锁定本地文件”。请使用 Chrome 或 Edge 较新版本，或继续使用「导入人员Excel」。',
      )
      return
    }
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: 'Excel',
            accept: {
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
              'application/vnd.ms-excel': ['.xls'],
            },
          },
        ],
      })
      const file = await handle.getFile()
      const buffer = await file.arrayBuffer()
      const result = await parseStaffBuffer(buffer)
      await idbSetStaffHandle(handle)
      staffHandleRef.current = handle
      staffLastModifiedRef.current = file.lastModified
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          startTransition(() => {
            applyStaffResult(result, file.name)
            setStaffFileLocked(true)
            setStaffPollEnabled(true)
            setStaffNeedRelink(false)
          })
        })
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        return
      }
      window.alert(`锁定失败：${error?.message || error}`)
      console.error(error)
    }
  }

  const clearStaffLock = async () => {
    try {
      staffHandleRef.current = null
      staffLastModifiedRef.current = 0
      setStaffPollEnabled(false)
      setStaffFileLocked(false)
      setStaffNeedRelink(false)
      await idbClearStaffHandle()
    } catch (error) {
      console.error('解除锁定失败', error)
    }
  }

  const handleStaffFile = async (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    try {
      const buffer = await readFileWithProgress(file)
      const result = await parseStaffBuffer(buffer)
      requestAnimationFrame(() => {
        startTransition(() => {
          setStaffFileLocked(false)
          setStaffNeedRelink(false)
          applyStaffResult(result, file.name)
        })
      })
    } catch (error) {
      window.alert('Excel 解析失败，请检查文件格式')
      console.error(error)
    }
    event.target.value = ''
  }

  const removeProjectById = (projectId) => {
    setProjects((prev) => prev.filter((p) => p.id !== projectId))
    setSelectedProject((prev) => (prev?.id === projectId ? null : prev))
  }

  const confirmDeleteProject = (project) => {
    if (
      !window.confirm(
        `确定删除工单「${project.name}」？\n时间：${project.startDate} ~ ${project.endDate}`,
      )
    ) {
      return
    }
    removeProjectById(project.id)
  }

  const handleProjectLineClick = (project) => {
    if (deleteMode) {
      confirmDeleteProject(project)
      return
    }
    setSelectedProject(project)
  }

  return (
    <main className="calendar-app">
      <header className="app-header">
        <div className="month-switch">
          <button type="button" onClick={() => changeMonth(-1)}>
            上个月
          </button>
          <h1>{monthTitle}</h1>
          <button type="button" onClick={() => changeMonth(1)}>
            下个月
          </button>
        </div>
        <div className="header-actions">
          <label className="delete-mode-toggle">
            <input
              type="checkbox"
              checked={deleteMode}
              onChange={(event) => setDeleteMode(event.target.checked)}
            />
            删除模式
          </label>
          <button className="lock-btn" type="button" onClick={() => void pickLockStaffFile()}>
            {staffFileLocked ? '更换锁定名单' : '锁定人员名单文件'}
          </button>
          {staffFileLocked && (
            <button className="secondary-btn" type="button" onClick={() => void clearStaffLock()}>
              解除锁定
            </button>
          )}
          <label className="import-btn">
            临时导入Excel
            <input type="file" accept=".xlsx,.xls" onChange={handleStaffFile} />
          </label>
          <button className="create-btn" type="button" onClick={() => setShowModal(true)}>
            创建项目
          </button>
        </div>
      </header>
      {staffNeedRelink && (
        <div className="staff-relink-banner" role="status">
          本地 Excel
          连接已失效或权限未通过，当前显示的是<strong>上次已缓存的名单</strong>。请点击「更换锁定名单」重新选择同一文件，即可恢复自动检测文件更新。
        </div>
      )}
      <p className="staff-tip">
        名单: {staffFileName || '未导入'} | 管理人员 {managers.length} 人 | 工人 {workers.length} 人
        {isCloudEnabled() ? ' | 云端同步已启用（免费 Supabase）' : ' | 当前仅本地缓存'}
        {staffFileLocked
          ? ' | 已锁定（名单已存本机浏览器，刷新保留；若文件句柄有效，保存 Excel 后约 8 秒内自动更新）'
          : ' | 名单已缓存到本机浏览器（刷新保留）'}
        {!staffFileLocked && supportsFilePicker()
          ? ' | 建议点「锁定人员名单文件」关联本地文件'
          : ''}
        {!supportsFilePicker() ? ' | 当前浏览器请用「临时导入Excel」' : ''}
        {deleteMode ? ' | 删除模式已开：点击蓝色工单条即可删除' : ''}
      </p>

      <section className="calendar-board">
        <div className="weekday-row">
          {weekdayHeaders.map((header) => (
            <div className="weekday" key={header}>
              {header}
            </div>
          ))}
        </div>

        {weeks.map((week, weekIndex) => {
          const segments = getWeekSegments(week)
          const laneCount = Math.max(
            1,
            segments.reduce((maxLane, segment) => Math.max(maxLane, segment.lane + 1), 0),
          )

          return (
            <div className="week-block" key={`week-${weekIndex}`}>
              <div className="week-days">
                {week.map((day) => (
                  <article className={`day-cell ${day.inCurrentMonth ? '' : 'muted'}`} key={day.key}>
                    <div className="day-number">{day.date.getDate()}</div>
                  </article>
                ))}
              </div>
              <div className="week-lines" style={{ height: `${laneCount * 28 + 4}px` }}>
                {segments.map((segment) => (
                  <button
                    type="button"
                    key={`${segment.project.id}-${weekIndex}`}
                    className={`project-line ${segment.continuedFromPrev ? 'continued-left' : 'start'} ${segment.continuedToNext ? 'continued-right' : 'end'} ${deleteMode ? 'delete-mode' : ''}`}
                    style={{
                      left: `calc(${segment.startIndex} * (100% / 7) + 6px)`,
                      width: `calc(${segment.span} * (100% / 7) - 12px)`,
                      top: `${segment.lane * 28 + 2}px`,
                    }}
                    title={
                      deleteMode ? `${segment.project.name}（点击删除）` : segment.project.name
                    }
                    onClick={() => handleProjectLineClick(segment.project)}
                  >
                    <span>{segment.project.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </section>

      {showModal && (
        <div className="modal-mask">
          <form className="project-modal" onSubmit={submitProject}>
            <h2>新建项目</h2>

            <label>
              项目名称
              <input
                value={form.name}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, name: event.target.value }))
                }
                placeholder="请输入项目名称"
              />
            </label>

            <div className="date-row">
              <label>
                开始日期
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, startDate: event.target.value }))
                  }
                />
              </label>
              <label>
                结束日期
                <input
                  type="date"
                  value={form.endDate}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, endDate: event.target.value }))
                  }
                />
              </label>
            </div>

            <div className="switch-row">
              <span>创建管理人员</span>
              <input
                type="checkbox"
                checked={form.managerEnabled}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, managerEnabled: event.target.checked }))
                }
              />
            </div>

            {form.managerEnabled && (
              <fieldset>
                <legend>选择管理人员</legend>
                <div className="select-grid">
                  {managers.length === 0 && <div>请先导入人员 Excel</div>}
                  {managers.map((manager) => (
                    <label key={manager.id}>
                      <input
                        type="checkbox"
                        checked={form.managerIds.includes(manager.id)}
                        onChange={() => togglePerson('managerIds', manager.id)}
                      />
                      {manager.name}({manager.sourceSheet})
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <div className="switch-row">
              <span>创建工人</span>
              <input
                type="checkbox"
                checked={form.workerEnabled}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, workerEnabled: event.target.checked }))
                }
              />
            </div>

            {form.workerEnabled && (
              <fieldset>
                <legend>选择工人</legend>
                <div className="select-grid">
                  {workers.length === 0 && <div>请先导入人员 Excel</div>}
                  {workers.map((worker) => (
                    <label key={worker.id}>
                      <input
                        type="checkbox"
                        checked={form.workerIds.includes(worker.id)}
                        onChange={() => togglePerson('workerIds', worker.id)}
                      />
                      {worker.name}({worker.sourceSheet})
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <div className="picked-summary">
              <div>
                管理人员: {form.managerIds.length > 0 ? getDisplayName(managers, form.managerIds) : '未选择'}
              </div>
              <div>工人: {form.workerIds.length > 0 ? getDisplayName(workers, form.workerIds) : '未选择'}</div>
            </div>

            <div className="modal-actions">
              <button type="button" onClick={closeModal}>
                取消
              </button>
              <button className="create-btn" type="submit">
                创建项目
              </button>
            </div>
          </form>
        </div>
      )}

      {selectedProject && (
        <div className="modal-mask">
          <div className="project-modal details-modal">
            <h2>项目详情</h2>
            <div className="detail-item">
              <strong>项目名称:</strong> {selectedProject.name}
            </div>
            <div className="detail-item">
              <strong>时间:</strong> {selectedProject.startDate} ~ {selectedProject.endDate}
            </div>
            <div className="detail-item">
              <strong>管理人员:</strong>{' '}
              {selectedProject.managerIds.length > 0
                ? getDisplayName(managers, selectedProject.managerIds)
                : '无'}
            </div>
            <div className="detail-item">
              <strong>工人:</strong>{' '}
              {selectedProject.workerIds.length > 0
                ? getDisplayName(workers, selectedProject.workerIds)
                : '无'}
            </div>
            <div className="modal-actions">
              {deleteMode && (
                <button
                  className="danger-btn"
                  type="button"
                  onClick={() => confirmDeleteProject(selectedProject)}
                >
                  删除此工单
                </button>
              )}
              <button className="create-btn" type="button" onClick={() => setSelectedProject(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App

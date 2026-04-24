(async () => {
  const dbName = 'natter'
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  try {
    const stores = {}
    for (const name of Array.from(db.objectStoreNames)) {
      stores[name] = await new Promise((resolve, reject) => {
        const tx = db.transaction(name, 'readonly')
        const req = tx.objectStore(name).getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    }
    const dump = { dbName, exportedAt: new Date().toISOString(), stores }
    const text = JSON.stringify(dump)
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `natter-indexeddb-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    console.log(`Downloaded ${a.download} (${text.length.toLocaleString()} bytes)`)
  } finally {
    db.close()
  }
})()

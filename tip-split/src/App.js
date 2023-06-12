import { useState, useEffect } from 'react'

import './App.css';

function App({ appId }) {

  const [tipSplit, setTipSplit] = useState([])
  const [newUsername, setNewUsername] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const fetchData = async (appId) => {
      setLoading(true)
      const response = await fetch('/getTipConfiguration?appId=' + appId)

      if(response.ok) {
        const data = await response.json()

        if(data.success) {
          setTipSplit(data.data)
        }
      }

      setLoading(false)
    }

    if(appId) {
      fetchData(appId)
    }
  }, [])

  const setUsernames = async (tipUsernames) => {
    setLoading(true)
    const response = await fetch(
      '/setTipSplit',
      {
        method: "post",
        body: JSON.stringify({
          appId,
          tipUsernames,
        }),
        headers: {
          'content-type': 'application/json',
        },
      }
    )

    setLoading(false)
    return await response.json()
  }

  const handleNewUsername = (e) => {
    if(e.key == 'Enter') {
      e.preventDefault()

      addNewUsername()
    }
  }

  const addNewUsername = async () => {
    const tipUsernames = tipSplit.map((el) => el.bitcoinJungleUsername)
    tipUsernames.push(newUsername)

    const data = await setUsernames(tipUsernames)

    if(data.success) {
      setNewUsername("")
      setTipSplit(data.data)
    } else {
      alert(data.message)
    }
  }

  const deleteUsername = async (obj) => {
    if(!window.confirm(`Are you sure you want to delete ${obj.bitcoinJungleUsername}?`)) {
      return
    }

    const tipUsernames = [...tipSplit.filter((el) => el.id !== obj.id).map((el) => el.bitcoinJungleUsername)]

    const data = await setUsernames(tipUsernames)

    if(data.success) {
      setTipSplit(data.data)
    } else {
      alert(data.message)
    }
  }

  if(!appId) {
    return (
      <div className="App">
        <header className="App-header">
          <h3>App not found :(</h3>
        </header>
      </div>
    )
  }

  return (
    <div className="App">
      <header className="App-header">
        <h3>Bitcoin Point of Sale Tip Configuration</h3>

        {tipSplit.map((el) => {
          return (
            <div key={el.id}>
              <button disabled={loading} onClick={() => deleteUsername(el)}>X</button>
              {" "}
              {el.bitcoinJungleUsername}
            </div>
          )
        })}
        <br />
        <input 
          placeholder="Add new user"
          type="text"
          value={newUsername}
          onKeyDown={handleNewUsername}
          onChange={(e) => setNewUsername(e.target.value)}
          disabled={loading} />

          <br />

          {loading &&
            <h5 style={{margin: 0}}>Loading ...</h5>
          }
      </header>
    </div>
  );
}

export default App;

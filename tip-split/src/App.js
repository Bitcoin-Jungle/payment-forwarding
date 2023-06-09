import { useState, useEffect } from 'react'

import './App.css';

function App() {

  const [appId, setAppId] = useState("")
  const [tipSplit, setTipSplit] = useState([])

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const appId = urlParams.get('appId')
    setAppId(appId)
  }, [])

  useEffect( () => {
    const fetchData = async (appId) => {
      const response = await fetch('/getTipConfiguration?appId=' + appId)

      if(response.ok) {
        const data = await response.json()

        if(data.success) {
          setTipSplit(data.data)
        }
      }
    }

    if(appId) {
      fetchData(appId)
    }
  }, [appId])

  return (
    <div className="App">
      <header className="App-header">
        <h3>Bitcoin Point of Sale Tip Configuration</h3>

        {tipSplit.map((el) => {
          return (
            <div key={el.id}>
              {el.bitcoinJungleUsername}
            </div>
          )
        })}
      </header>
    </div>
  );
}

export default App;

import { useState, useEffect, useRef } from 'react'
import { QRCode } from "react-qrcode-logo"
import { bech32 } from "bech32"
import { Buffer } from "buffer"
import ReactToPrint from "react-to-print"

import './App.css';

function App({ appId }) {
  const componentRef = useRef(null)

  const [tipSplit, setTipSplit] = useState([])
  const [newUsername, setNewUsername] = useState("")
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState(null)

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

        <div style={{border: "1px solid white", padding: 10, borderRadius: 10, marginBottom: 10}}>
          <button onClick={() => setMode("split")}>
            Tip Split
          </button>
          {" "}
          <button onClick={() => setMode("qrcode")}>
            Tip QR Code
          </button>
        </div>

        {mode === "split" && 
          <div>
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
          </div>
        }

        {mode === "qrcode" &&
          <div>

            <div ref={componentRef}>
              <QRCode
                value={
                  bech32.encode(
                    "lnurl",
                    bech32.toWords(
                      Buffer.from(
                        `${window.location.protocol}//${window.location.hostname}/tipLnurl?appId=${appId}`,
                        "utf8",
                      ),
                    ),
                    1500,
                  ).toUpperCase()
                }
                size={320}
                logoImage={"./BJQRLogo.png"}
                logoWidth={100}
                id="react-qrcode-logo"
              />
            </div>

            <div style={{border: "1px solid white", padding: 10, borderRadius: 10, marginTop: 10}}>
              <ReactToPrint
                trigger={() => <button>Print QR Code</button>}
                content={() => componentRef.current}
                onBeforeGetContent={() => {
                  const qrcodeLogo = document.getElementById("react-qrcode-logo")
                  if (qrcodeLogo) {
                    qrcodeLogo.style.height = "256px"
                    qrcodeLogo.style.width = "256px"
                  }
                }}
              />
            </div>

          </div>
        }
      </header>
    </div>
  );
}

export default App;

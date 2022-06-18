const formEl = document.querySelector("form#addStore")

formEl.addEventListener('submit', async (e) => {
	e.preventDefault()
		
	const storeId = document.querySelector("#storeId").value
	const rate 	  = document.querySelector("#rate").value
	const bitcoinJungleUsername = document.querySelector("#bitcoinJungleUsername").value

	return fetch("https://btcpayserver.bitcoinjungle.app/addStore", {
      "method": "POST",
      "headers": {
            "Content-Type": "application/json; charset=utf-8"
      },
      "body": JSON.stringify({
            storeId: storeId,
            rate: rate,
            bitcoinJungleUsername: bitcoinJungleUsername
      })
	})
	.then((res) => res.json())
	.then((data) => {
		if(data.error) {
			alert(data.message)
			return
		}

		alert("Store saved successfully")
		formEl.reset()
	})
	.catch((err) => {
		alert(err)
	});
})
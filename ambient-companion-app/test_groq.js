
async function testEvent() {
  const houseState = {
    devices: {
      night_light: false
    },
    time: "06:00",
    audioEvents: []
  };

  const res = await fetch("http://localhost:3000/api/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      houseState,
      sourceProfile: "parents",
      voiceCommand: "turn on night light and turn off it at 7 am"
    })
  });
  
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

testEvent();

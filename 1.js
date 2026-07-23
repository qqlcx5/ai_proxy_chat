const res = await fetch("http://66.154.117.189:3000/v1/models", {
  method: "GET",
  headers: {
    "Authorization": "Bearer sk-GcznFTZ07A2eSJw8kmKhmLgHQiY8zHd8E75NThJyTuDvo0Ww"
  }
});
console.log(await res.json());

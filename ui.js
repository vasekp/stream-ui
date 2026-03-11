import { callWasm } from "./main.js";

document.getElementById("run").onclick = async () => {

  const text = document.getElementById("input").value;

  const result = await callWasm(text);

  console.log(result);

};

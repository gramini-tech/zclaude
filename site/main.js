// Copy buttons for the install commands. Everything else on the page works
// without JavaScript (tabs are radio inputs, the FAQ uses <details>).

function selectText(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copyFrom(button) {
  const target = document.getElementById(button.dataset.copy);
  if (!target) return;
  const text = target.textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
    button.dataset.state = "done";
    button.textContent = "Copied";
  } catch {
    selectText(target);
    button.textContent = "Press ⌘C";
  }
  setTimeout(() => {
    delete button.dataset.state;
    button.textContent = "Copy";
  }, 1800);
}

for (const button of document.querySelectorAll("button.copy")) {
  button.addEventListener("click", () => copyFrom(button));
}

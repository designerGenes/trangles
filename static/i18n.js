async function loadStrings() {
  try {
    // Attempt to load the strings file. Depending on how the server is set up, 
    // the path might need to be adjusted (e.g. if resources/ is not served).
    const response = await fetch('/resources/strings.json');
    if (!response.ok) {
      console.warn('Failed to load strings.json, falling back to default text.');
      return;
    }
    const strings = await response.json();

    // Populate data-i18n text content
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (strings[key]) {
        // If data-i18n-html is true, use innerHTML, else textContent
        if (el.getAttribute('data-i18n-html') === 'true') {
          el.innerHTML = strings[key];
        } else {
          el.textContent = strings[key];
        }
      }
    });

    // Populate data-i18n attributes (e.g., placeholder, aria-label, title)
    // We look for elements that have attributes starting with data-i18n-
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-i18n-') && attr.name !== 'data-i18n-html') {
          const targetAttr = attr.name.replace('data-i18n-', '');
          const key = attr.value;
          if (strings[key]) {
            el.setAttribute(targetAttr, strings[key]);
          }
        }
      }
    }
  } catch (err) {
    console.error('Error loading i18n strings:', err);
  }
}

// Run string population when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadStrings);
} else {
  loadStrings();
}

function openPage(page) {
    window.location.href = page;
}

const toggle = document.getElementById("themeToggle");
const savedTheme = localStorage.getItem("theme");

if (savedTheme === "dark") {
    document.body.classList.add("dark-mode");
    document.documentElement.classList.remove("dark-mode");
}

if (toggle) {
    const updateToggle = () => {
        const isDark = document.body.classList.contains("dark-mode");
        toggle.setAttribute("aria-pressed", String(isDark));
        toggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    };

    const setTheme = (isDark) => {
        document.body.classList.toggle("dark-mode", isDark);
        document.documentElement.classList.remove("dark-mode");
        localStorage.setItem("theme", isDark ? "dark" : "light");
        updateToggle();
        document.dispatchEvent(new CustomEvent("site-theme-change", { detail: { isDark } }));
    };

    updateToggle();
    toggle.addEventListener("click", () => {
        setTheme(!document.body.classList.contains("dark-mode"));
    });
}
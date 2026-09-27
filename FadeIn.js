document.addEventListener("DOMContentLoaded", function () {
    const expTitle = document.querySelector(".Exptitle");

    const observer = new IntersectionObserver(
        (entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    expTitle.style.opacity = 1;
                    observer.unobserve(expTitle);
                }
            });
        },
        { threshold: 0.5 }
    );

    observer.observe(expTitle);
});
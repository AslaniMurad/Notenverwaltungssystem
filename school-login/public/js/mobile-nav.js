/* public/js/mobile-nav.js - Mobile Navigation Handler */

document.addEventListener('DOMContentLoaded', function() {
  // Mobile Navigation Toggle
  const mobileNavToggle = document.querySelector('.mobile-nav-toggle');
  const sidebar = document.querySelector('.app-sidebar, .teacher-sidebar');
  
  if (mobileNavToggle && sidebar) {
    // Toggle Button Click - ÖFFNEN UND SCHLIESSEN
    mobileNavToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      sidebar.classList.toggle('mobile-active');
      this.classList.toggle('active');
      
      // Change icon
      if (this.classList.contains('active')) {
        this.innerHTML = '✕'; // Close icon
      } else {
        this.innerHTML = '☰'; // Menu icon
      }
    });
  }

  // Close mobile nav when clicking outside
  document.addEventListener('click', function(event) {
    if (!event.target.closest('.app-sidebar') && 
        !event.target.closest('.teacher-sidebar') &&
        !event.target.closest('.mobile-nav-toggle')) {
      if (sidebar && sidebar.classList.contains('mobile-active')) {
        sidebar.classList.remove('mobile-active');
        if (mobileNavToggle) {
          mobileNavToggle.classList.remove('active');
          mobileNavToggle.innerHTML = '☰';
        }
      }
    }
  });

  // Close sidebar when clicking on a link inside
  if (sidebar) {
    const sidebarLinks = sidebar.querySelectorAll('a:not(.nav-trigger)');
    sidebarLinks.forEach(function(link) {
      link.addEventListener('click', function() {
        sidebar.classList.remove('mobile-active');
        if (mobileNavToggle) {
          mobileNavToggle.classList.remove('active');
          mobileNavToggle.innerHTML = '☰';
        }
      });
    });
  }

  // Mobile Table Enhancement
  enhanceMobileTable();
});

// Funktion um Tabellen mobile-freundlich zu machen
function enhanceMobileTable() {
  const tables = document.querySelectorAll('table:not(.desktop-only)');
  
  tables.forEach(function(table) {
    const headers = table.querySelectorAll('thead th');
    const rows = table.querySelectorAll('tbody tr');
    
    // Füge data-label Attribute hinzu für mobile Darstellung
    rows.forEach(function(row) {
      const cells = row.querySelectorAll('td');
      cells.forEach(function(cell, index) {
        if (headers[index]) {
          cell.setAttribute('data-label', headers[index].textContent.trim());
        }
      });
    });
  });
}

// Device Detection Info
if (window.innerWidth <= 768) {
  document.body.classList.add('is-mobile');
  console.log('📱 Mobile device detected');
} else {
  document.body.classList.add('is-desktop');
  console.log('💻 Desktop device detected');
}

// Update on resize
window.addEventListener('resize', function() {
  if (window.innerWidth <= 768) {
    document.body.classList.add('is-mobile');
    document.body.classList.remove('is-desktop');
  } else {
    document.body.classList.add('is-desktop');
    document.body.classList.remove('is-mobile');
  }
});

// ==========================================================================
// Nave Landing Page — Waitlist Form Handler
// ==========================================================================

import { db } from './firebase-config.js';
import { collection, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// Collection references
const waitlistCollection = collection(db, 'waitlist');
const partnerInquiriesCollection = collection(db, 'partner-inquiries');

/**
 * Handle form submission
 * @param {Event} event - Form submit event
 * @param {string} formId - ID of the form element
 * @param {string} successId - ID of the success message element
 */
async function handleFormSubmit(event, formId, successId) {
    event.preventDefault();
    
    const form = document.getElementById(formId);
    const emailInput = form.querySelector('input[type="email"]');
    const submitButton = form.querySelector('button[type="submit"]');
    const successMessage = document.getElementById(successId);
    
    const email = emailInput.value.trim();
    
    if (!email) return;
    
    // Disable button and show loading state
    const originalText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Joining...';
    
    try {
        // Add email to Firestore
        await addDoc(waitlistCollection, {
            email: email,
            createdAt: serverTimestamp(),
            source: 'landing_page'
        });
        
        // Show success message
        form.classList.add('hidden');
        successMessage.classList.remove('hidden');
        
        // Also hide the other form's note if it exists
        const formNote = form.parentElement.querySelector('.form-note');
        if (formNote) {
            formNote.style.display = 'none';
        }
        
    } catch (error) {
        console.error('Error adding to waitlist:', error);
        
        // Show error state
        submitButton.textContent = 'Error - Try Again';
        submitButton.disabled = false;
        
        // Reset button after 3 seconds
        setTimeout(() => {
            submitButton.textContent = originalText;
        }, 3000);
    }
}

/**
 * Handle partner inquiry form submission
 * @param {Event} event - Form submit event
 */
async function handlePartnerFormSubmit(event) {
    event.preventDefault();
    
    const form = document.getElementById('partner-form');
    const nameInput = document.getElementById('partner-name');
    const emailInput = document.getElementById('partner-email');
    const companyInput = document.getElementById('partner-company');
    const submitButton = form.querySelector('button[type="submit"]');
    const successMessage = document.getElementById('partner-success');
    
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const company = companyInput.value.trim();
    
    if (!name || !email || !company) return;
    
    // Disable button and show loading state
    const originalText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Submitting...';
    
    try {
        // Add inquiry to Firestore
        await addDoc(partnerInquiriesCollection, {
            name: name,
            email: email,
            company: company,
            createdAt: serverTimestamp(),
            source: window.location.pathname
        });
        
        // Show success message
        form.classList.add('hidden');
        successMessage.classList.remove('hidden');
        
    } catch (error) {
        console.error('Error submitting partner inquiry:', error);
        
        // Show error state
        submitButton.textContent = 'Error - Try Again';
        submitButton.disabled = false;
        
        // Reset button after 3 seconds
        setTimeout(() => {
            submitButton.textContent = originalText;
        }, 3000);
    }
}

/**
 * Animate count up effect
 * @param {HTMLElement} element - The element to animate
 * @param {number} target - The target number
 * @param {number} duration - Animation duration in ms
 */
function animateCount(element, target, duration = 2000) {
    const start = 0;
    const startTime = performance.now();
    
    function easeOutQuart(t) {
        return 1 - Math.pow(1 - t, 4);
    }
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = easeOutQuart(progress);
        const current = Math.floor(start + (target - start) * easedProgress);
        
        element.textContent = current.toLocaleString();
        
        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    
    requestAnimationFrame(update);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Hero form
    const heroForm = document.getElementById('waitlist-form');
    if (heroForm) {
        heroForm.addEventListener('submit', (e) => {
            handleFormSubmit(e, 'waitlist-form', 'form-success');
        });
    }
    
    // Bottom CTA form
    const bottomForm = document.getElementById('waitlist-form-bottom');
    if (bottomForm) {
        bottomForm.addEventListener('submit', (e) => {
            handleFormSubmit(e, 'waitlist-form-bottom', 'form-success-bottom');
        });
    }
    
    // Partner inquiry form
    const partnerForm = document.getElementById('partner-form');
    if (partnerForm) {
        partnerForm.addEventListener('submit', handlePartnerFormSubmit);
    }

    // Waitlist modal form
    const waitlistModalForm = document.getElementById('waitlist-modal-form');
    if (waitlistModalForm) {
        waitlistModalForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('waitlist-modal-email').value.trim();
            if (!email) return;
            const submitBtn = waitlistModalForm.querySelector('.modal-submit');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting...';
            try {
                await addDoc(waitlistCollection, {
                    email: email,
                    createdAt: serverTimestamp(),
                    source: 'nav_modal'
                });
                waitlistModalForm.classList.add('hidden');
                document.getElementById('waitlist-modal-success').classList.remove('hidden');
            } catch (error) {
                console.error('Error adding to waitlist:', error);
                submitBtn.textContent = 'Error - Try Again';
                submitBtn.disabled = false;
            }
        });
    }
    
    // Count-up animation for location stat
    const locationCount = document.getElementById('location-count');
    if (locationCount) {
        const target = parseInt(locationCount.dataset.target, 10);
        let hasAnimated = false;
        
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !hasAnimated) {
                    hasAnimated = true;
                    animateCount(locationCount, target, 2500);
                }
            });
        }, { threshold: 0.5 });
        
        observer.observe(locationCount);
    }
});


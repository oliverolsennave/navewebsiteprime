// entity-detail.js — Shared entity detail rendering module
// Used by both map.html and ask-gabe.html

// ── Constants ─────────────────────────────────────────

export const COLLECTION_FOR_TYPE = {
    church: 'Churches',
    missionary: 'missionaries',
    pilgrimage: 'pilgrimageSites',
    school: 'schools',
    vocation: 'vocations',
    retreat: 'retreats',
    business: 'businesses',
    campus: 'bibleStudies'
};

// Reverse map: display type → canonical lowercase type
const TYPE_DISPLAY_MAP = {
    'Church': 'church', 'Missionary': 'missionary', 'Pilgrimage': 'pilgrimage',
    'Retreat': 'retreat', 'School': 'school', 'Vocation': 'vocation',
    'Business': 'business', 'Campus Ministry': 'campus'
};

// ── Normalize ─────────────────────────────────────────

/**
 * Accepts either data shape (map's {_type, _docId, _coords} or ask's {type, id, coordinates})
 * and returns the canonical _type/_docId/_coords shape that renderEntityDetailHTML expects.
 */
export function normalizeEntityData(d) {
    if (d._type && d._docId) return d; // already canonical
    const copy = { ...d };
    if (!copy._type && copy.type) copy._type = TYPE_DISPLAY_MAP[copy.type] || copy.type.toLowerCase();
    if (!copy._docId && copy.id) copy._docId = copy.id;
    if (!copy._coords && copy.coordinates) copy._coords = copy.coordinates;
    return copy;
}

// ── Subcollection loader ──────────────────────────────

/**
 * Async loads gallery, staff, groups (church), job openings (business),
 * retreat offerings (retreat), pilgrimage offerings/listings/site data (pilgrimage).
 *
 * @param {Object} d - Entity data with _type, _docId
 * @param {Object} firestore - { db, collection, getDocs, getDoc, doc, query, where }
 * @returns {boolean} true if any subcollection data was loaded
 */
export async function loadSubcollectionData(d, firestore) {
    const { db, collection: col, getDocs, getDoc, doc: docRef, query: q, where: w } = firestore;
    const type = d._type;
    const docId = d._docId;
    let loaded = false;
    try {
        if (type === 'church') {
            const gallerySnap = await getDocs(col(db, 'Churches', docId, 'gallery'));
            if (gallerySnap.size > 0) { d._gallery = gallerySnap.docs.map(g => g.data()); loaded = true; }
            const groupsSnap = await getDocs(col(db, 'Churches', docId, 'groups'));
            if (groupsSnap.size > 0) { d._groups = groupsSnap.docs.map(g => ({ id: g.id, ...g.data() })); loaded = true; }
            const staffSnap = await getDocs(col(db, 'Churches', docId, 'staff'));
            if (staffSnap.size > 0) { d._staff = staffSnap.docs.map(s => ({ id: s.id, ...s.data() })); loaded = true; }
        }
        if (type === 'business') {
            const jobsSnap = await getDocs(col(db, 'businesses', docId, 'jobOpenings'));
            if (jobsSnap.size > 0) { d._jobs = jobsSnap.docs.map(j => ({ id: j.id, ...j.data() })); loaded = true; }
        }
        if (type === 'retreat') {
            const orgId = d.organizationId || docId;
            try {
                const roSnap = await getDocs(q(col(db, 'retreatOfferings'), w('organizationId', '==', orgId), w('isActive', '==', true)));
                if (roSnap.size > 0) { d._retreatOfferings = roSnap.docs.map(o => ({ id: o.id, ...o.data() })); loaded = true; }
            } catch (e) { /* retreatOfferings may not exist */ }
            if (d.organizationId) {
                try {
                    const offerSnap = await getDocs(q(col(db, 'retreats'), w('organizationId', '==', d.organizationId)));
                    const others = offerSnap.docs.filter(o => o.id !== docId).map(o => ({ id: o.id, ...o.data() }));
                    if (others.length) { d._otherRetreats = others; loaded = true; }
                } catch (e) { /* silent */ }
            }
        }
        if (type === 'pilgrimage') {
            try {
                const offeringSnap = await getDocs(q(col(db, 'pilgrimageOfferings'), w('siteId', '==', docId)));
                if (offeringSnap.size > 0) { d._offerings = offeringSnap.docs.filter(o => o.id !== docId).map(o => ({ id: o.id, ...o.data() })); loaded = true; }
            } catch (e) { /* pilgrimageOfferings may not exist */ }
            if (d.siteId) {
                try {
                    const siteDoc = await getDoc(docRef(db, 'pilgrimageSites', d.siteId));
                    if (siteDoc.exists()) {
                        const site = siteDoc.data();
                        d.siteName = d.siteName || site.name;
                        d.siteDescription = d.siteDescription || site.description;
                        d.siteHistoricalSignificance = d.siteHistoricalSignificance || site.historicalSignificance;
                        d.siteVisitingHours = d.siteVisitingHours || site.visitingHours;
                        d.siteAdmissionInfo = d.siteAdmissionInfo || site.admissionInfo;
                        d.siteImageURL = d.siteImageURL || site.imageURL;
                        d.siteCreatedByUserId = d.siteCreatedByUserId || site.createdByUserId;
                        loaded = true;
                    }
                } catch (e) { /* silent */ }
            }
            try {
                const listingSnap = await getDocs(q(col(db, 'pilgrimageListings'), w('pilgrimageId', '==', docId)));
                if (listingSnap.size > 0) {
                    const now = new Date();
                    d._listings = listingSnap.docs.map(l => ({ id: l.id, ...l.data() }))
                        .filter(l => {
                            let listDate = null;
                            if (l.date && l.date.toDate) listDate = l.date.toDate();
                            else if (l.date && l.date.seconds) listDate = new Date(l.date.seconds * 1000);
                            else if (typeof l.date === 'string') listDate = new Date(l.date);
                            return (!listDate || listDate >= now) && (l.spots === undefined || l.spots > 0);
                        })
                        .sort((a, b) => {
                            const da = a.date?.seconds || 0, db2 = b.date?.seconds || 0;
                            return da - db2;
                        });
                    loaded = true;
                }
            } catch (e) { /* pilgrimageListings may not exist */ }
            try {
                const travSnap = await getDocs(col(db, 'pilgrimageSites', docId, 'travelFacilitations'));
                if (travSnap.size > 0) { d.travelFacilitations = travSnap.docs.map(t => t.data()); loaded = true; }
            } catch (e) { /* silent */ }
        }
    } catch (err) {
        console.warn('Subcollection load error:', err);
    }
    return loaded;
}

// ── Utility functions ─────────────────────────────────

export function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

export function getEntityIcon(type) {
    const icons = { church:'⛪', missionary:'✝️', pilgrimage:'🗺️', retreat:'🙏', school:'🎓', vocation:'📿', business:'🏪', campus:'🎒' };
    return icons[type] || '📍';
}

export function getTypeLabel(type) {
    const labels = { church:'Church', missionary:'Missionary', pilgrimage:'Pilgrimage', retreat:'Retreat', school:'School', vocation:'Vocation', business:'Business', campus:'Campus Ministry' };
    return labels[type] || type;
}

// ── Parsers ───────────────────────────────────────────

export function parseSchedule(scheduleData) {
    if (!scheduleData || typeof scheduleData !== 'object' || Array.isArray(scheduleData)) return {};
    const result = {};
    for (const [day, value] of Object.entries(scheduleData)) {
        if (Array.isArray(value)) {
            const times = [];
            for (const v of value) {
                if (typeof v === 'string') times.push(v);
                else if (typeof v === 'object' && v.time) {
                    let t = v.time;
                    if (v.language && v.language !== 'English') t += ` (${v.language})`;
                    times.push(t);
                }
            }
            if (times.length > 0) result[day] = times;
        } else if (typeof value === 'string') {
            result[day] = [value];
        }
    }
    return result;
}

export function renderScheduleRows(schedule) {
    const dayOrder = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Monday-Friday'];
    let html = '';
    for (const day of dayOrder) {
        if (schedule[day] && schedule[day].length > 0) {
            html += `<div class="entity-detail-schedule-row"><span class="day">${day}</span><span class="times">${schedule[day].map(t => escapeHTML(t)).join(', ')}</span></div>`;
        }
    }
    return html;
}

export function parseEvent(data) {
    const title = data.title || data.name || '';
    if (!title) return null;
    let eventDate = null;
    if (data.date && data.date.toDate) {
        eventDate = data.date.toDate();
    } else if (data.date && data.date.seconds) {
        eventDate = new Date(data.date.seconds * 1000);
    } else if (typeof data.date === 'string' && data.date.trim()) {
        // Handle "Month Day" strings (e.g. "March 22") by appending current year
        let dateStr = data.date.trim();
        let parsed = new Date(dateStr);
        if (isNaN(parsed.getTime())) {
            // Try appending current year: "March 22" → "March 22, 2026"
            parsed = new Date(dateStr + ', ' + new Date().getFullYear());
        }
        if (!isNaN(parsed.getTime())) {
            eventDate = parsed;
        }
    }
    // If we still don't have a valid date, show the event anyway with raw date text
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (eventDate && !isNaN(eventDate.getTime())) {
        return { title, date: eventDate, time: data.time || null, location: data.location || null,
            month: months[eventDate.getMonth()] || '', dayNum: eventDate.getDate() || '',
            rawDate: data.date, description: data.description || null };
    }
    // Fallback: show event with raw date string
    return { title, date: new Date(9999, 0, 1), time: data.time || null, location: data.location || null,
        month: (typeof data.date === 'string' ? data.date.split(' ')[0].substring(0, 3) : ''), dayNum: (typeof data.date === 'string' ? data.date.split(' ')[1] || '' : ''),
        rawDate: data.date, description: data.description || null };
}

// ── Builders ──────────────────────────────────────────

export function buildHeroImage(d) {
    const images = (d.images || d.imageNames || []).filter(img => img && typeof img === 'string' && img.trim());
    const singleImg = d.imageURL || d.siteImageURL || '';
    if (images.length > 1) {
        let html = `<div class="entity-detail-hero-carousel" id="detail-hero-carousel">`;
        images.forEach((img, i) => {
            const url = img.startsWith('http') ? img : `https://firebasestorage.googleapis.com/v0/b/navefirebase.firebasestorage.app/o/${encodeURIComponent(img)}?alt=media`;
            html += `<img src="${url}" alt="" class="${i === 0 ? 'active' : ''}" loading="lazy" onerror="this.remove()">`;
        });
        html += `<div class="entity-detail-hero-dots">`;
        images.forEach((_, i) => { html += `<span class="${i === 0 ? 'active' : ''}" onclick="heroCarouselTo(${i})"></span>`; });
        html += `</div></div>`;
        return html;
    }
    const url = (images.length === 1 ? images[0] : singleImg);
    if (!url || typeof url !== 'string' || !url.trim()) return '';
    const src = url.startsWith('http') ? url : `https://firebasestorage.googleapis.com/v0/b/navefirebase.firebasestorage.app/o/${encodeURIComponent(url)}?alt=media`;
    return `<img class="entity-detail-hero" src="${src}" alt="" loading="lazy" onerror="this.remove()">`;
}

export function buildHeader(d, type) {
    const icon = getEntityIcon(type);
    const name = d.name || d.title || d.parishName || 'Unknown';
    let badgeHTML = '';
    const badge = d.diocese || d.category || d.type || d.schoolType || d.retreatType || d.organization || getTypeLabel(type);
    badgeHTML = `<span class="entity-detail-type-badge">${escapeHTML(badge)}</span>`;
    if (d.isVerified) badgeHTML += `<span class="entity-detail-type-badge" style="background:rgba(34,197,94,0.1);color:#16a34a;margin-left:4px;">✓ Verified</span>`;
    if (d.subcategory && type === 'business') badgeHTML += `<span class="entity-detail-type-badge" style="margin-left:4px;">${escapeHTML(d.subcategory)}</span>`;
    let memberHTML = '';
    if (d.memberCount) memberHTML = `<div class="entity-detail-member-count"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>${d.memberCount} members</div>`;
    return `<div class="entity-detail-header"><div class="entity-detail-icon">${icon}</div><div class="entity-detail-header-info"><div class="entity-detail-name">${escapeHTML(name)}</div>${badgeHTML}${memberHTML}</div></div>`;
}

export function buildEditBar(d, options) {
    if (!options.isOwner || !options.editMode) return '';
    const onDeleteStr = options.onDelete ? `onclick="${options.onDelete}"` : '';
    return `<div class="entity-detail-edit-bar"><button class="entity-detail-add-section-btn" onclick="openAddSectionModal()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add Section</button><button class="entity-detail-delete-btn" ${onDeleteStr}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>Delete</button></div>`;
}

export function buildLocation(d) {
    const parts = [];
    if (d.address) parts.push(d.address);
    if (d.city && d.state) parts.push(`${d.city}, ${d.state}`);
    else if (d.city) parts.push(d.city);
    else if (d.state) parts.push(d.state);
    else if (d.location && typeof d.location === 'string') parts.push(d.location);
    if (!parts.length && d.locationPrimary) {
        if (d.locationPrimary.city) parts.push(d.locationPrimary.city + (d.locationPrimary.state ? ', ' + d.locationPrimary.state : ''));
    }
    const loc = parts.join(' · ');
    if (!loc) return '';
    return `<div class="entity-detail-location"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg><span>${escapeHTML(loc)}</span></div>`;
}

export function buildDescription(d, options) {
    const desc = d.description || d.bio || '';
    if (!desc && !options.editMode) return '';
    if (options.editMode && options.isOwner) return (options.buildEditableField ? options.buildEditableField(d, 'description', 'Description', desc, true) : '');
    const truncated = desc.length > 400 ? desc.substring(0, 397) + '...' : desc;
    return `<div class="entity-detail-description">${escapeHTML(truncated)}</div>`;
}

export function buildMapsUrl(d) {
    if (d._coords) return `https://maps.google.com/maps?q=${d._coords.lat},${d._coords.lng}`;
    if (d.address && d.city) return `https://maps.google.com/maps?q=${encodeURIComponent(d.address + ', ' + d.city + ' ' + (d.state || ''))}`;
    return '';
}

export function buildContact(d) {
    const phone = d.phone || d.phoneNumber || d.contactInfo?.phone || '';
    const email = d.email || d.contactInfo?.email || '';
    const website = d.website || d.websiteURL || d.link || d.contactInfo?.website || '';
    if (!phone && !email && !website) return '';
    let html = '<div class="entity-detail-contact">';
    if (phone) html += `<div class="entity-detail-contact-row"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg><a href="tel:${phone}">${escapeHTML(phone)}</a></div>`;
    if (email) html += `<div class="entity-detail-contact-row"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg><a href="mailto:${email}">${escapeHTML(email)}</a></div>`;
    if (website) { const url = website.startsWith('http') ? website : 'https://' + website; const display = website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''); html += `<div class="entity-detail-contact-row"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2z"/></svg><a href="${url}" target="_blank" rel="noopener">${escapeHTML(display)}</a></div>`; }
    html += '</div>';
    return html;
}

export function buildSocialMedia(socialObj) {
    if (!socialObj || typeof socialObj !== 'object') return '';
    const entries = Object.entries(socialObj).filter(([,v]) => v);
    if (!entries.length) return '';
    let html = `<div class="entity-detail-section-title">Social Media</div><div class="entity-detail-social">`;
    for (const [platform, url] of entries) {
        const link = String(url).startsWith('http') ? url : 'https://' + url;
        html += `<a href="${link}" target="_blank" rel="noopener">${escapeHTML(platform)}</a>`;
    }
    html += '</div>';
    return html;
}

export function buildInfoItem(label, value) {
    if (!value) return '';
    return `<div class="entity-detail-info-item"><div class="entity-detail-info-label">${escapeHTML(label)}</div><div class="entity-detail-info-value">${escapeHTML(String(value))}</div></div>`;
}

export function buildInfoFull(title, text) {
    if (!text) return '';
    return `<div class="entity-detail-info-full"><div class="info-title">${escapeHTML(title)}</div><div class="info-text">${escapeHTML(String(text))}</div></div>`;
}

export function buildGallery(photos) {
    if (!photos || !photos.length) return '';
    let html = `<div class="entity-detail-section-title">Gallery</div><div class="entity-detail-gallery">`;
    photos.slice(0, 9).forEach((p, i) => {
        const url = p.storageUrl || p.imageURL || p.url || '';
        if (url) html += `<img src="${url}" alt="${escapeHTML(p.imageType || '')}" loading="lazy" onerror="this.style.display='none'" onclick="openGalleryLightbox(${i})">`;
    });
    html += '</div>';
    return html;
}

export function buildStaffList(staff) {
    if (!staff || !staff.length) return '';
    let html = `<div class="entity-detail-section-title">Staff & Leadership</div>`;
    staff.forEach(s => {
        const name = s.name || s.staffName || '';
        const role = s.role || s.title || s.position || '';
        const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
        html += `<div class="entity-detail-staff-item"><div class="entity-detail-staff-avatar">${initials}</div><div><div class="entity-detail-staff-name">${escapeHTML(name)}</div>${role ? `<div class="entity-detail-staff-role">${escapeHTML(role)}</div>` : ''}</div></div>`;
    });
    return html;
}

export function buildTypeActions(d, type) {
    let html = '';
    if (type === 'missionary' && d.donationLink) html += `<a href="${d.donationLink}" target="_blank" rel="noopener" class="entity-detail-action-btn primary-action">Donate</a>`;
    if (type === 'missionary' && d.calendlyLink) html += `<a href="${d.calendlyLink}" target="_blank" rel="noopener" class="entity-detail-action-btn primary-action">Schedule</a>`;
    if (type === 'retreat') { const regUrl = d.registrationURL || ''; if (regUrl) html += `<a href="${regUrl}" target="_blank" rel="noopener" class="entity-detail-action-btn primary-action">Register</a>`; }
    if (type === 'vocation' && d.applicationLink) html += `<a href="${d.applicationLink}" target="_blank" rel="noopener" class="entity-detail-action-btn primary-action">Apply</a>`;
    if (type === 'school') { const enrollUrl = d.enrollmentURL || ''; if (enrollUrl) html += `<a href="${enrollUrl}" target="_blank" rel="noopener" class="entity-detail-action-btn primary-action">Enroll</a>`; }
    return html ? `<div class="entity-detail-actions">${html}</div>` : '';
}

export function buildFooter(d) {
    return '';
}

// ── Data ──────────────────────────────────────────────

export function getVocationProcessSteps(type) {
    const steps = {
        'Priesthood': [
            { title: 'Discernment', desc: 'Meet with a vocation director and begin prayer and reflection.' },
            { title: 'Seminary Application', desc: 'Apply to a seminary recommended by your diocese.' },
            { title: 'Propaedeutic Stage', desc: 'Initial formation period focused on human and spiritual growth.' },
            { title: 'Philosophy Studies', desc: '2 years studying philosophy and liberal arts.' },
            { title: 'Theology Studies', desc: '4 years of theological formation.' },
            { title: 'Ordination', desc: 'Ordination to the diaconate, then priesthood.' }
        ],
        'Religious Life': [
            { title: 'Inquiry', desc: 'Visit communities and attend come-and-see events.' },
            { title: 'Postulancy', desc: 'Live with the community for an initial trial period.' },
            { title: 'Novitiate', desc: '1-2 years of intensive formation and study of the rule.' },
            { title: 'Temporary Vows', desc: 'Profess vows for a set period (typically 3-6 years).' },
            { title: 'Perpetual Vows', desc: 'Make a lifelong commitment to the community.' }
        ],
        'Permanent Deacon': [
            { title: 'Inquiry', desc: 'Meet with the diaconate formation director.' },
            { title: 'Aspirancy', desc: '1 year of discernment with your spouse (if married).' },
            { title: 'Candidacy', desc: '3-4 years of academic and pastoral formation.' },
            { title: 'Ordination', desc: 'Ordained to the permanent diaconate.' }
        ]
    };
    return steps[type] || steps['Priesthood'];
}

export const ADD_SECTIONS = {
    church: [
        { id: 'events', title: 'Events', desc: 'Add parish events', fields: ['title','description','date','time','location'] },
        { id: 'groups', title: 'Groups & Ministries', desc: 'Add groups or ministries', fields: ['name','description','meetingTime'] },
        { id: 'staff', title: 'Staff & Leadership', desc: 'Add staff members', fields: ['name','role'] },
        { id: 'social', title: 'Social Media', desc: 'Add social media links', fields: ['platform','url'] },
        { id: 'psas', title: 'Pastor PSAs', desc: 'Post announcements', fields: ['title','message','pastorName'] },
        { id: 'gallery', title: 'Gallery Photos', desc: 'Add photos of your parish', fields: ['imageType','url'] }
    ],
    business: [
        { id: 'hours', title: 'Hours', desc: 'Set business hours', fields: ['day','openTime','closeTime'] },
        { id: 'events', title: 'Events', desc: 'Add business events', fields: ['eventName','eventDate','eventTime','eventDescription','eventSignUpLink'] },
        { id: 'marketing', title: 'Marketing', desc: 'Newsletter, reviews, awards', fields: ['marketingNewsletter','customerReviewsSummary','awardsRecognition'] },
        { id: 'philanthropy', title: 'Philanthropy', desc: 'Community involvement', fields: ['communityPartnerships','communityInvolvement'] },
        { id: 'jobs', title: 'Job Openings', desc: 'Post job listings', fields: ['title','type','salary','description'] }
    ],
    school: [
        { id: 'classical', title: 'Classical Education', desc: 'Trivium, Latin, Great Books', fields: ['triviumQuadrivium','latinGreekStudies','greatBooks','socraticMethod'] },
        { id: 'academics', title: 'Academics', desc: 'Enrollment, tuition, financial aid', fields: ['gradeLevels','enrollment','classSize','tuition','financialAid','admissionsProcess','enrollmentURL'] },
        { id: 'formation', title: 'Catholic Formation', desc: 'Mass, confession, sacraments', fields: ['religiousEducation','sacramentalPreparation','dailyMass','confessionSchedule','adoration','virtueFormation'] }
    ],
    missionary: [
        { id: 'contact', title: 'Contact', desc: 'Email, phone, scheduling', fields: ['email','phone','calendlyLink'] },
        { id: 'impact', title: 'Impact Stats', desc: 'Students, campuses, years', fields: ['impactStats.studentsReached','impactStats.campusesCovered','impactStats.yearsOfService'] },
        { id: 'links', title: 'Links', desc: 'Website and donation', fields: ['website','donationLink'] }
    ],
    retreat: [
        { id: 'details', title: 'Retreat Details', desc: 'Topics, speakers, schedule', fields: ['retreatTopics','speakerInfo','scheduleStructure','capacity','pricing'] },
        { id: 'spiritual', title: 'Spiritual Life', desc: 'Mass, confession, adoration', fields: ['massSchedule','confessionAvailability','adorationOpportunities','spiritualDirection'] },
        { id: 'org', title: 'Organization Info', desc: 'Director, contact, frequency', fields: ['directorName','email','phone','retreatFrequency','accommodationInfo'] },
        { id: 'marketing', title: 'Marketing', desc: 'Social media, newsletter', fields: ['socialMedia','newsletter','testimonials'] }
    ],
    vocation: [
        { id: 'contact', title: 'Contact Info', desc: 'Email, phone, website', fields: ['email','phone','website','applicationLink'] },
        { id: 'location', title: 'Location Details', desc: 'Full address', fields: ['address','city','state','zipCode'] },
        { id: 'formation', title: 'Formation Info', desc: 'Process, requirements, discernment', fields: ['formationProcess','requirements','discernmentOpportunities'] },
        { id: 'director', title: 'Director Info', desc: 'Director and community name', fields: ['directorName','communityName'] }
    ],
    pilgrimage: [
        { id: 'description', title: 'Description', desc: 'Site description and history', fields: ['description','siteHistoricalSignificance'] }
    ],
    campus: [
        { id: 'details', title: 'Ministry Details', desc: 'Meeting times and chaplain', fields: ['meetingTimes','chaplainName','chaplainEmail'] },
        { id: 'contact', title: 'Contact', desc: 'Email, phone, website', fields: ['email','phone','website'] }
    ]
};

// ── Type renderers ────────────────────────────────────

export function renderChurch(d, options) {
    let html = '';
    const entityId = d._docId || d.id || '';

    // ── 1. UPCOMING EVENTS (shown above schedules for prominence, matches iOS) ──
    if (Array.isArray(d.events) && d.events.length > 0) {
        const upcoming = d.events.map(e => parseEvent(e)).filter(e => e !== null).sort((a, b) => a.date - b.date).slice(0, 5);
        if (upcoming.length) {
            html += `<div class="entity-detail-events-heading">Upcoming Events</div><div class="entity-detail-events"><div class="entity-detail-events-inner">`;
            for (const evt of upcoming) {
                const dateStr = evt.rawDate || (evt.month + ' ' + evt.dayNum);
                html += `<div class="entity-detail-event-item">`;
                html += `<div class="entity-detail-event-title">${escapeHTML(evt.title)}</div>`;
                html += `<div class="entity-detail-event-meta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${escapeHTML(dateStr)}</div>`;
                if (evt.time) html += `<div class="entity-detail-event-meta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${escapeHTML(evt.time)}</div>`;
                html += `</div>`;
            }
            html += '</div></div>';
        }
    }

    // ── 2. SCHEDULE — Navy blue segmented control (Mass / Confession / Adoration) ──
    const hasMass = d.massSchedule && typeof d.massSchedule === 'object' && Object.keys(parseSchedule(d.massSchedule)).length > 0;
    const hasConfession = d.confessionSchedule && typeof d.confessionSchedule === 'object' && Object.keys(parseSchedule(d.confessionSchedule)).length > 0;
    const hasAdoration = d.adorationSchedule && typeof d.adorationSchedule === 'object' && Object.keys(parseSchedule(d.adorationSchedule)).length > 0;

    if (hasMass || hasConfession || hasAdoration) {
        const schedId = 'sched-' + entityId;
        html += `<div class="entity-detail-schedule-tabs" id="${schedId}-tabs">`;
        if (hasMass) html += `<button class="entity-detail-schedule-tab active" onclick="switchScheduleTab('${schedId}','mass')">Mass</button>`;
        if (hasConfession) html += `<button class="entity-detail-schedule-tab${!hasMass ? ' active' : ''}" onclick="switchScheduleTab('${schedId}','confession')">Confession</button>`;
        if (hasAdoration) html += `<button class="entity-detail-schedule-tab${!hasMass && !hasConfession ? ' active' : ''}" onclick="switchScheduleTab('${schedId}','adoration')">Adoration</button>`;
        html += `</div>`;

        if (hasMass) html += `<div class="entity-detail-schedule-tab-content active" id="${schedId}-mass"><div class="entity-detail-schedule">${renderScheduleRows(parseSchedule(d.massSchedule))}</div></div>`;
        if (hasConfession) html += `<div class="entity-detail-schedule-tab-content${!hasMass ? ' active' : ''}" id="${schedId}-confession"><div class="entity-detail-schedule">${renderScheduleRows(parseSchedule(d.confessionSchedule))}</div></div>`;
        if (hasAdoration) html += `<div class="entity-detail-schedule-tab-content${!hasMass && !hasConfession ? ' active' : ''}" id="${schedId}-adoration"><div class="entity-detail-schedule">${renderScheduleRows(parseSchedule(d.adorationSchedule))}</div></div>`;
    }

    // ── 3. PASTOR ANNOUNCEMENTS ──
    if (Array.isArray(d.pastorPSAs) && d.pastorPSAs.length > 0) {
        html += `<div class="entity-detail-section-title">Pastor Announcements</div>`;
        d.pastorPSAs.forEach(psa => {
            html += `<div class="entity-detail-psa"><div class="entity-detail-psa-title">${escapeHTML(psa.title || '')}</div><div class="entity-detail-psa-text">${escapeHTML(psa.message || '')}</div>`;
            if (psa.pastorName) html += `<div class="entity-detail-psa-meta">— ${escapeHTML(psa.pastorName)}</div>`;
            html += `</div>`;
        });
    }

    // ── 4. GET INVOLVED — 2×2 grid (OCIA, Confirmation, First Eucharist, Marriage Prep) — always visible ──
    const getInvolvedPrograms = [
        { icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`, title: 'OCIA', sub: 'Start your journey' },
        { icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 0.67s0.74 2.65 0.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l0.03-0.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5 0.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-0.36 3.6-1.21 4.62-2.58 0.39 1.29 0.59 2.65 0.59 4.04 0 2.65-2.15 4.8-4.8 4.8z"/></svg>`, title: 'Confirmation', sub: 'Youth & adult' },
        { icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61z"/></svg>`, title: 'First Eucharist', sub: 'Sacrament prep' },
        { icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`, title: 'Marriage Prep', sub: 'Pre-Cana' }
    ];
    html += `<div class="entity-detail-section-title">Get Involved</div>`;
    html += `<div class="entity-detail-get-involved">`;
    getInvolvedPrograms.forEach(p => {
        const url = d.prepClassSignupURL || d.signupURL || '#';
        html += `<a href="${url !== '#' ? escapeHTML(url) : '#'}" ${url !== '#' ? 'target="_blank" rel="noopener"' : ''} class="entity-detail-program-card">${p.icon}<span class="program-title">${p.title}</span><span class="program-sub">${p.sub}</span></a>`;
    });
    html += `</div>`;

    // ── 5. SIGN-UP SHEETS BUTTON ──
    const signupURL = d.signupURL || d.prepClassSignupURL || '';
    html += `<button class="entity-detail-signup-btn" onclick="${signupURL ? `window.open('${escapeHTML(signupURL)}','_blank')` : 'void(0)'}">
                <div class="entity-detail-signup-icon"><svg viewBox="0 0 24 24" fill="currentColor" color="#3366CC"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg></div>
                <div class="entity-detail-signup-text"><div class="title">Sign-Up Sheets</div><div class="sub">Groups, Liturgy, Service & More</div></div>
                <div class="entity-detail-signup-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>
            </button>`;

    // ── 6. STAFF & LEADERSHIP (from subcollection) ──
    if (d._staff && d._staff.length > 0) html += buildStaffList(d._staff);

    // ── 7. GROUPS & MINISTRIES (from subcollection) ──
    if (d._groups && d._groups.length > 0) {
        html += `<div class="entity-detail-section-title">Groups & Ministries</div>`;
        d._groups.forEach(g => {
            html += buildInfoFull(g.name || 'Ministry', g.description || g.meetingTime || '');
        });
    }

    // ── 8. LOCATION MAP ──
    if (d.latitude && d.longitude) {
        const lat = d.latitude;
        const lng = d.longitude;
        const addr = encodeURIComponent(d.address || d.name || '');
        html += `<div class="entity-detail-map-section">
                    <div class="section-label">Location</div>
                    <div class="entity-detail-map-embed">
                        <iframe src="https://www.openstreetmap.org/export/embed.html?bbox=${lng-0.005}%2C${lat-0.003}%2C${lng+0.005}%2C${lat+0.003}&layer=mapnik&marker=${lat}%2C${lng}" loading="lazy"></iframe>
                    </div>
                </div>`;
    }

    // ── 9. BULLETIN UPLOAD ──
    html += `<div class="entity-detail-bulletin" onclick="window.location.href='join.html'">
                <svg viewBox="0 0 24 24" fill="none" stroke="#3366CC" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                <div class="bulletin-title">Upload Bulletin</div>
                <div class="bulletin-sub">Scan your weekly bulletin to update events and schedules</div>
            </div>`;

    // ── 10. MESSAGE PARISH ──
    const onMessageStr = options.onMessage ? `onclick="${options.onMessage}"` : `onclick="messageEntityOwner()"`;
    html += `<button class="entity-detail-message-btn" ${onMessageStr}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                Message Parish
            </button>`;

    // ── 11. GALLERY (from subcollection) ──
    if (d._gallery && d._gallery.length > 0) html += buildGallery(d._gallery);

    // ── 12. SOCIAL MEDIA ──
    if (d.socialMedia && typeof d.socialMedia === 'object') html += buildSocialMedia(d.socialMedia);

    return html;
}

export function renderLockedChurch(d) {
    let html = '';

    // Hero text
    html += `<div class="entity-detail-upsell-hero">Scan your bulletin, we do the rest.</div>`;

    // 2×2 benefits grid
    html += `<div class="entity-detail-benefits-grid">`;

    const benefits = [
        { icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="12" y1="14" x2="12" y2="18"/><line x1="10" y1="16" x2="14" y2="16"/></svg>`, title: 'Share Events', desc: 'Parish events on the Nave map' },
        { icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="18" y1="8" x2="18" y2="14"/><line x1="15" y1="11" x2="21" y2="11"/></svg>`, title: 'Give Christ', desc: 'OCIA, Confirmation, First Eucharist signups' },
        { icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l2 2 4-4"/></svg>`, title: 'Mass Rosters', desc: 'Lector, altar server, sacristan signups' },
        { icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><circle cx="18" cy="4" r="3" fill="#22C55E" stroke="none"/></svg>`, title: 'Notify Laity', desc: 'Mass changes, reminders, announcements' }
    ];

    benefits.forEach(b => {
        html += `<div class="entity-detail-benefit">
                    <div class="entity-detail-benefit-icon">${b.icon}</div>
                    <div class="entity-detail-benefit-title">${b.title}</div>
                    <div class="entity-detail-benefit-desc">${b.desc}</div>
                </div>`;
    });

    html += `</div>`;

    // CTA: "Unlock Parish For Everyone" with rainbow border
    html += `<div style="padding: 0 20px 8px;">
                <a href="join.html" class="entity-detail-unlock-btn">Unlock Parish For Everyone</a>
            </div>`;

    // "See an example" link — find an unlocked parish
    html += `<a href="#" class="entity-detail-see-example" onclick="showExampleUnlockedParish(); return false;">See an example</a>`;

    return html;
}

export function renderBusiness(d, options) {
    let html = '';

    // Features (top capsules like iOS hero)
    if (Array.isArray(d.features) && d.features.length > 0) {
        html += `<div class="entity-detail-section-title">Highlights</div><div class="entity-detail-programs">`;
        d.features.slice(0, 5).forEach(f => {
            const text = typeof f === 'object' ? (f.name || f.title || JSON.stringify(f)) : f;
            html += `<div class="entity-detail-program-pill">${escapeHTML(text)}</div>`;
        });
        html += '</div>';
    }

    // Hours
    if (Array.isArray(d.hours) && d.hours.length > 0) {
        html += `<div class="entity-detail-section-title">Hours</div><div class="entity-detail-hours">`;
        d.hours.forEach(h => {
            const day = h.day || h.dayOfWeek || '';
            const isClosed = h.isClosed === true;
            const time = isClosed ? 'Closed' : (h.openTime && h.closeTime ? `${h.openTime} - ${h.closeTime}` : h.hours || h.time || h.open || '');
            if (day) html += `<div class="entity-detail-hours-row"><span class="day">${escapeHTML(day)}</span><span class="time">${escapeHTML(time)}</span></div>`;
        });
        html += '</div>';
    } else if (typeof d.hours === 'object' && d.hours && !Array.isArray(d.hours)) {
        html += `<div class="entity-detail-section-title">Hours</div><div class="entity-detail-hours">`;
        for (const [day, time] of Object.entries(d.hours)) {
            html += `<div class="entity-detail-hours-row"><span class="day">${escapeHTML(day)}</span><span class="time">${escapeHTML(String(time))}</span></div>`;
        }
        html += '</div>';
    }

    // Services
    const serviceFields = [
        ['Services Offered', d.servicesOffered], ['Special Offers', d.specialOffers],
        ['Loyalty Program', d.loyaltyProgram], ['Membership Benefits', d.membershipBenefits]
    ].filter(([,v]) => v);
    if (serviceFields.length) {
        html += `<div class="entity-detail-section-title">Services</div>`;
        serviceFields.forEach(([label, value]) => { html += buildInfoFull(label, value); });
    }

    // Events (premium events array + single event)
    const hasEvents = d.eventTitle || (Array.isArray(d.premiumEvents) && d.premiumEvents.length > 0);
    if (hasEvents) {
        html += `<div class="entity-detail-section-title">Events</div>`;
        if (Array.isArray(d.premiumEvents)) {
            d.premiumEvents.forEach(evt => {
                let evtHTML = `<div class="entity-detail-info-full"><div class="info-title">${escapeHTML(evt.name || '')}</div><div class="info-text">${evt.date ? escapeHTML(evt.date) : ''}${evt.time ? ' at ' + escapeHTML(evt.time) : ''}${evt.details ? '<br>' + escapeHTML(evt.details) : ''}</div>`;
                if (evt.signUpLink) evtHTML += `<a href="${evt.signUpLink}" target="_blank" rel="noopener" style="color:#3366CC;font-size:0.82rem;">Sign Up →</a>`;
                evtHTML += `</div>`;
                html += evtHTML;
            });
        }
        if (d.eventTitle) {
            html += `<div class="entity-detail-info-full"><div class="info-title">${escapeHTML(d.eventTitle)}${d.eventSubtitle ? ' — ' + escapeHTML(d.eventSubtitle) : ''}</div><div class="info-text">${d.eventDate ? escapeHTML(d.eventDate) : ''}${d.eventTime ? ' at ' + escapeHTML(d.eventTime) : ''}</div></div>`;
        }
        if (d.cateringOptions) html += buildInfoFull('Catering Options', d.cateringOptions);
        if (d.privateEventsInfo) html += buildInfoFull('Private Events', d.privateEventsInfo);
    }

    // Philanthropy
    const hasPhilanthropy = d.communityPartnerships || d.communityInvolvement || d.additionalEventsSummary;
    if (hasPhilanthropy) {
        html += `<div class="entity-detail-section-title">Community & Philanthropy</div>`;
        if (d.communityPartnerships) html += buildInfoFull('Parish Support', d.communityPartnerships);
        if (d.communityInvolvement) html += buildInfoFull('Nonprofit Partnerships', d.communityInvolvement);
        if (d.additionalEventsSummary) html += buildInfoFull('Event Sponsorships', d.additionalEventsSummary);
    }

    // Awards & Reviews
    if (d.awardsRecognition) html += buildInfoFull('Awards & Recognition', d.awardsRecognition);
    if (d.customerReviewsSummary) html += buildInfoFull('Customer Reviews', d.customerReviewsSummary);
    if (d.marketingNewsletter) html += buildInfoFull('Newsletter', d.marketingNewsletter);

    // Job Openings (from subcollection)
    if (d._jobs && d._jobs.length > 0) {
        html += `<div class="entity-detail-section-title">Job Openings</div>`;
        d._jobs.forEach(job => {
            html += `<div class="entity-detail-job"><div class="entity-detail-job-title">${escapeHTML(job.title || '')}</div>`;
            const meta = [job.type, job.salary].filter(Boolean).join(' · ');
            if (meta) html += `<div class="entity-detail-job-meta">${escapeHTML(meta)}</div>`;
            if (job.description) html += `<div class="entity-detail-job-desc">${escapeHTML(job.description)}</div>`;
            html += '</div>';
        });
    }

    // Social Media
    html += buildSocialMedia(d.socialMedia || d.contactInfo?.socialMedia);

    return html;
}

export function renderSchool(d, options) {
    let html = '';

    // Administration
    const principal = d.principalName || d.headmasterName || '';
    if (principal) html += buildInfoFull('Principal / Headmaster', principal);

    // Academics grid
    const academicFields = [
        ['Grade Levels', d.gradeLevels], ['Enrollment', d.enrollment],
        ['Class Size', d.classSize], ['Tuition', d.tuition],
        ['Financial Aid', d.financialAid], ['Admissions', d.admissionsProcess]
    ].filter(([, v]) => v);

    if (academicFields.length) {
        html += `<div class="entity-detail-section-title">Academics</div><div class="entity-detail-info-grid">`;
        academicFields.forEach(([label, value]) => { html += buildInfoItem(label, value); });
        html += '</div>';
        if (d.parentInvolvement) html += buildInfoFull('Parent Involvement', d.parentInvolvement);
        if (d.enrollmentURL) html += `<div style="margin:0 16px 12px;"><a href="${d.enrollmentURL}" target="_blank" rel="noopener" class="entity-detail-action-btn primary-action" style="display:inline-flex;">Apply / Enroll</a></div>`;
    }

    // Classical Education
    const classicalFields = [
        ['Trivium & Quadrivium', d.triviumQuadrivium], ['Latin & Greek', d.latinGreekStudies],
        ['Great Books', d.greatBooks], ['Socratic Method', d.socraticMethod]
    ].filter(([, v]) => v);
    if (classicalFields.length) {
        html += `<div class="entity-detail-section-title">Classical Education</div>`;
        classicalFields.forEach(([label, value]) => { html += buildInfoFull(label, value); });
    }

    // Catholic Formation
    const formationFields = [
        ['Religious Education', d.religiousEducation], ['Sacramental Preparation', d.sacramentalPreparation],
        ['Daily Mass', d.dailyMass], ['Confession', d.confessionSchedule],
        ['Adoration', d.adoration], ['Virtue Formation', d.virtueFormation]
    ].filter(([, v]) => v);
    if (formationFields.length) {
        html += `<div class="entity-detail-section-title">Catholic Formation</div>`;
        formationFields.forEach(([label, value]) => {
            if (typeof value === 'object') html += buildInfoFull(label, JSON.stringify(value));
            else html += buildInfoFull(label, value);
        });
    }

    // Marketing
    const marketingFields = [
        ['Social Media', d.socialMedia], ['Newsletter', d.newsletter],
        ['Virtual Tours', d.virtualTours], ['Open Houses', d.openHouses]
    ].filter(([, v]) => v);
    if (marketingFields.length) {
        html += `<div class="entity-detail-section-title">Marketing & Connect</div>`;
        marketingFields.forEach(([label, value]) => {
            if (typeof value === 'object') html += buildSocialMedia(value);
            else html += buildInfoFull(label, value);
        });
    }

    return html;
}

export function renderMissionary(d, options) {
    let html = '';

    // Role & Organization
    if (d.role) html += buildInfoFull('Role', d.role);
    if (d.organization) html += buildInfoFull('Organization', d.organization);
    if (d.campus) html += buildInfoFull('Campus', d.campus);

    // Impact Stats
    const stats = d.impactStats;
    if (stats && (stats.studentsReached || stats.campusesCovered || stats.yearsOfService)) {
        html += `<div class="entity-detail-section-title">Impact</div><div class="entity-detail-stats">`;
        if (stats.studentsReached) html += `<div class="entity-detail-stat"><div class="stat-value">${escapeHTML(String(stats.studentsReached))}</div><div class="stat-label">Students Reached</div></div>`;
        if (stats.campusesCovered) html += `<div class="entity-detail-stat"><div class="stat-value">${escapeHTML(String(stats.campusesCovered))}</div><div class="stat-label">Campuses</div></div>`;
        if (stats.yearsOfService) html += `<div class="entity-detail-stat"><div class="stat-value">${escapeHTML(String(stats.yearsOfService))}</div><div class="stat-label">Years</div></div>`;
        html += '</div>';
    }

    // Edit mode fields for missionary
    if (options.editMode && options.isOwner) {
        const bef = options.buildEditableField;
        if (bef) {
            html += bef(d, 'name', 'Name', d.name, false);
            html += bef(d, 'role', 'Role', d.role, false);
            html += bef(d, 'organization', 'Organization', d.organization, false);
            html += bef(d, 'website', 'Website', d.website, false);
            html += bef(d, 'donationLink', 'Donation Link', d.donationLink, false);
            html += bef(d, 'email', 'Email', d.email, false);
            html += bef(d, 'phone', 'Phone', d.phone, false);
            html += bef(d, 'calendlyLink', 'Calendly Link', d.calendlyLink, false);
        }
    }

    // FOCUS Bible Studies
    if (Array.isArray(d.bibleStudies) && d.bibleStudies.length > 0) {
        html += `<div class="entity-detail-section-title">Bible Studies</div><div class="entity-detail-schedule">`;
        d.bibleStudies.forEach(bs => {
            const day = bs.dayOfWeek || '';
            const time = bs.time || '';
            const participants = bs.currentParticipants && bs.maxParticipants ? `${bs.currentParticipants}/${bs.maxParticipants}` : '';
            html += `<div class="entity-detail-schedule-row"><span class="day">${escapeHTML(day)} ${escapeHTML(time)}</span><span class="times">${participants ? escapeHTML(participants) + ' spots' : ''}</span></div>`;
        });
        html += '</div>';
    }

    return html;
}

export function renderRetreat(d, options) {
    let html = '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // ── Retreat Offerings (matches iOS retreatOfferingsSection) ──
    const offerings = d._retreatOfferings || [];
    html += `<div class="entity-detail-travel-section"><div class="travel-heading">Retreat Offerings</div>`;
    if (offerings.length > 0) {
        offerings.forEach(o => {
            const price = o.price ? `$${Math.round(o.price)}` : '';
            let dateText = '';
            const oDate = o.date?.toDate ? o.date.toDate() : (o.date?.seconds ? new Date(o.date.seconds * 1000) : (typeof o.date === 'string' ? new Date(o.date) : null));
            if (oDate && !isNaN(oDate.getTime())) dateText = `${months[oDate.getMonth()]} ${oDate.getDate()}, ${oDate.getFullYear()}`;
            const duration = o.duration && o.duration !== 'TBD' ? o.duration : '';
            const cap = o.capacity && o.capacity > 0 ? o.capacity : 0;
            const desc = o.description || '';
            const loc = o.location || '';
            const title = o.title || 'Retreat';

            html += `<div class="retreat-offering-card" onclick="openRetreatOfferingDetail('${o.id}')">`;
            html += `<div class="retreat-offering-top"><div class="retreat-offering-left">`;
            if (price) html += `<div class="retreat-offering-price">${escapeHTML(price)}<span class="per-person">per person</span></div>`;
            if (dateText) html += `<div class="retreat-offering-meta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${escapeHTML(dateText)}</div>`;
            if (duration) html += `<div class="retreat-offering-meta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${escapeHTML(duration)}</div>`;
            html += `</div><div class="retreat-offering-right"><div class="retreat-offering-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>`;
            if (cap > 0) html += `<div class="retreat-offering-spots">${cap} spots</div>`;
            html += `</div></div>`;
            html += `<div class="retreat-offering-title">${escapeHTML(title)}</div>`;
            if (desc) html += `<div class="retreat-offering-desc">${escapeHTML(desc)}</div>`;
            if (loc) html += `<div class="retreat-offering-location"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${escapeHTML(loc)}</div>`;
            html += `</div>`;
        });
    } else {
        html += `<div class="entity-detail-travel-empty">No upcoming retreats are currently available.</div>`;
    }
    html += `</div>`;

    // Dates & Pricing grid
    const dateFields = [
        ['Date', d.date ? (typeof d.date === 'string' ? d.date : '') : ''],
        ['Duration', d.duration], ['Price', d.price], ['Capacity', d.capacity],
        ['Formats', d.retreatFormats], ['Group Sizes', d.groupSizes]
    ].filter(([, v]) => v);
    if (dateFields.length) {
        html += `<div class="entity-detail-section-title">Details</div><div class="entity-detail-info-grid">`;
        dateFields.forEach(([label, value]) => { html += buildInfoItem(label, value); });
        html += '</div>';
    }

    // Organization
    if (d.organizationName) {
        html += `<div class="entity-detail-section-title">Organization</div>`;
        html += buildInfoFull(d.organizationName, d.organizationDescription);
        if (d.organizationWebsite) {
            const url = d.organizationWebsite.startsWith('http') ? d.organizationWebsite : 'https://' + d.organizationWebsite;
            html += `<div style="margin:0 16px 12px;"><a href="${url}" target="_blank" rel="noopener" class="entity-detail-action-btn">Organization Website</a></div>`;
        }
    }

    // Program
    const programFields = [
        ['Topics & Themes', d.retreatTopics], ['Speaker Info', d.speakerInfo],
        ['Schedule & Structure', d.scheduleStructure], ['Pricing Details', d.pricing]
    ].filter(([, v]) => v);
    if (programFields.length) {
        html += `<div class="entity-detail-section-title">Program</div>`;
        programFields.forEach(([label, value]) => { html += buildInfoFull(label, value); });
    }

    // Spiritual Life
    const spirFields = [
        ['Mass Schedule', d.massSchedule], ['Confession', d.confessionAvailability],
        ['Adoration', d.adorationOpportunities], ['Spiritual Direction', d.spiritualDirection],
        ['Prayer Formats', d.prayerFormats]
    ].filter(([, v]) => v);
    if (spirFields.length) {
        html += `<div class="entity-detail-section-title">Spiritual Life</div>`;
        spirFields.forEach(([label, value]) => {
            if (typeof value === 'object' && !Array.isArray(value)) {
                const schedule = parseSchedule(value);
                if (Object.keys(schedule).length) html += `<div class="entity-detail-schedule">${renderScheduleRows(schedule)}</div>`;
                else html += buildInfoFull(label, JSON.stringify(value));
            } else {
                html += buildInfoFull(label, value);
            }
        });
    }

    // Logistics
    const logFields = [
        ['Director', d.directorName], ['Accommodation', d.accommodationInfo],
        ['Frequency', d.retreatFrequency]
    ].filter(([, v]) => v);
    if (logFields.length) {
        html += `<div class="entity-detail-section-title">Logistics</div>`;
        logFields.forEach(([label, value]) => { html += buildInfoFull(label, value); });
    }

    // Address
    const addr = [d.city, d.state, d.zipCode].filter(Boolean).join(', ');
    if (addr) html += buildInfoFull('Location', addr);

    // Testimonials
    if (d.testimonials) html += buildInfoFull('Testimonials', d.testimonials);

    // Other retreat offerings (legacy — from same org)
    if (d._otherRetreats && d._otherRetreats.length > 0) {
        html += `<div class="entity-detail-section-title">Other Retreats</div>`;
        d._otherRetreats.forEach(r => {
            html += buildInfoFull(r.title || r.retreatTitle || r.name || 'Retreat', r.description || r.date || '');
        });
    }

    // Social
    html += buildSocialMedia(d.socialMedia);

    // Message Retreat (full-width blue button — matches iOS)
    const onMessageStr = options.onMessage ? `onclick="${options.onMessage}"` : `onclick="messageEntityOwner()"`;
    html += `<button class="entity-detail-message-btn" ${onMessageStr}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                Message Retreat
            </button>`;

    return html;
}

export function renderPilgrimage(d, options) {
    let html = '';

    // Site info
    if (d.siteName || d.siteDescription) {
        html += `<div class="entity-detail-section-title">Site Information</div>`;
        if (d.siteName) html += buildInfoFull(d.siteName, d.siteDescription);
        if (d.siteHistoricalSignificance) html += buildInfoFull('Historical Significance', d.siteHistoricalSignificance);
        if (d.siteVisitingHours) html += buildInfoFull('Visiting Hours', d.siteVisitingHours);
        if (d.siteAdmissionInfo) html += buildInfoFull('Admission', d.siteAdmissionInfo);
    }

    // ── Travel Facilitations (matches iOS PilgrimageListingCard) ──
    html += `<div class="entity-detail-travel-section"><div class="travel-heading">Travel Facilitations</div>`;
    const listings = d._listings || [];
    const pilgrimageOfferings = d._offerings || [];
    const hasContent = listings.length > 0 || pilgrimageOfferings.length > 0;
    if (listings.length > 0) {
        listings.forEach(listing => {
            const price = listing.price ? `$${Math.round(listing.price)}` : '';
            const spots = listing.spots || 0;
            const limited = spots > 0 && spots <= 5;
            // Format date range
            let dateText = '';
            const startDate = listing.date?.toDate ? listing.date.toDate() : (listing.date?.seconds ? new Date(listing.date.seconds * 1000) : (typeof listing.date === 'string' ? new Date(listing.date) : null));
            const endDate = listing.endDate?.toDate ? listing.endDate.toDate() : (listing.endDate?.seconds ? new Date(listing.endDate.seconds * 1000) : (typeof listing.endDate === 'string' ? new Date(listing.endDate) : null));
            if (startDate && !isNaN(startDate.getTime())) {
                const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                const sd = startDate.getDate(), sm = months[startDate.getMonth()], sy = startDate.getFullYear();
                if (endDate && !isNaN(endDate.getTime()) && endDate.getTime() !== startDate.getTime()) {
                    const ed = endDate.getDate(), em = months[endDate.getMonth()], ey = endDate.getFullYear();
                    if (sy === ey && startDate.getMonth() === endDate.getMonth()) {
                        dateText = `${sm} ${sd}–${ed}, ${sy}`;
                    } else if (sy === ey) {
                        dateText = `${sm} ${sd}–${em} ${ed}, ${sy}`;
                    } else {
                        dateText = `${sm} ${sd}, ${sy}–${em} ${ed}, ${ey}`;
                    }
                } else {
                    dateText = `${sm} ${sd}, ${sy}`;
                }
            } else if (typeof listing.date === 'string') {
                dateText = listing.date;
            }
            const dest = listing.destination || '';
            const regUrl = listing.registrationURL || '';
            const listingId = listing.id || '';
            html += `<div class="entity-detail-listing-card">`;
            html += `<div class="entity-detail-listing-info">`;
            html += `<div class="entity-detail-listing-price">${escapeHTML(price)}${limited ? '<span class="limited-badge">Limited</span>' : ''}</div>`;
            if (dateText) html += `<div class="entity-detail-listing-date"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${escapeHTML(dateText)}</div>`;
            if (spots > 0) html += `<div class="entity-detail-listing-spots">${spots} spots available</div>`;
            html += `</div>`;
            html += `<button class="entity-detail-listing-explore${spots === 0 ? ' disabled' : ''}" onclick="openPilgrimageReserve('${escapeHTML(listingId)}')"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><path d="M12 8l4 4-4 4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Explore</button>`;
            html += `</div>`;
        });
    }
    // Pilgrimage offerings — also inside Travel Facilitations
    if (pilgrimageOfferings.length > 0) {
        pilgrimageOfferings.forEach(o => {
            const title = o.title || o.name || 'Offering';
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            let oDateText = '';
            const oStartDate = o.date?.toDate ? o.date.toDate() : (o.date?.seconds ? new Date(o.date.seconds * 1000) : (typeof o.date === 'string' ? new Date(o.date) : null));
            if (oStartDate && !isNaN(oStartDate.getTime())) oDateText = `${months[oStartDate.getMonth()]} ${oStartDate.getDate()}, ${oStartDate.getFullYear()}`;
            else if (typeof o.date === 'string') oDateText = o.date;
            const oDesc = o.description || '';
            const oId = o.id || '';
            html += `<div class="entity-detail-listing-card" style="flex-direction:column;gap:10px;">`;
            html += `<div style="font-size:1.05rem;font-weight:700;color:#111;">${escapeHTML(title)}</div>`;
            if (oDateText || oDesc) html += `<div style="font-size:0.88rem;color:#666;line-height:1.5;">${oDateText ? escapeHTML(oDateText) + (oDesc ? ' · ' : '') : ''}${oDesc ? escapeHTML(oDesc.length > 150 ? oDesc.substring(0, 147) + '...' : oDesc) : ''}</div>`;
            html += `<button class="entity-detail-listing-explore" onclick="openPilgrimageOfferingDetail('${escapeHTML(oId)}')" style="align-self:flex-start;margin-top:4px;"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>Learn More</button>`;
            html += `</div>`;
        });
    }
    if (!hasContent) {
        html += `<div class="entity-detail-travel-empty">No upcoming trips are currently available.</div>`;
    }
    html += `</div>`;

    // Pilgrimage type
    if (d.type && d.type !== d._type) html += buildInfoFull('Pilgrimage Type', d.type);

    // Message Pilgrimage (full-width blue button — matches iOS)
    const onMessageStr = options.onMessage ? `onclick="${options.onMessage}"` : `onclick="messageEntityOwner()"`;
    html += `<button class="entity-detail-message-btn" ${onMessageStr}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                Message Pilgrimage
            </button>`;

    return html;
}

export function renderVocation(d, options) {
    let html = '';

    // Overview grid
    const infoFields = [
        ['Vocation Director', d.directorName], ['Community', d.communityName],
        ['Vocation Type', d.type && d.type !== d._type ? d.type : '']
    ].filter(([, v]) => v);
    if (infoFields.length) {
        html += `<div class="entity-detail-section-title">Overview</div><div class="entity-detail-info-grid">`;
        infoFields.forEach(([label, value]) => { html += buildInfoItem(label, value); });
        html += '</div>';
    }

    // Formation
    const formFields = [
        ['Formation Process', d.formationProcess],
        ['Requirements', d.requirements],
        ['Discernment Opportunities', d.discernmentOpportunities]
    ].filter(([, v]) => v);
    if (formFields.length) {
        html += `<div class="entity-detail-section-title">Formation & Discernment</div>`;
        formFields.forEach(([label, value]) => { html += buildInfoFull(label, value); });
    } else {
        // Show hardcoded process steps like iOS does when no formation data
        const vocType = d.type || 'Priesthood';
        const steps = getVocationProcessSteps(vocType);
        html += `<div class="entity-detail-section-title">Formation Process</div>`;
        steps.forEach((step, i) => {
            html += `<div class="entity-detail-step"><div class="entity-detail-step-num">${i + 1}</div><div class="entity-detail-step-text"><div class="entity-detail-step-title">${escapeHTML(step.title)}</div><div class="entity-detail-step-desc">${escapeHTML(step.desc)}</div></div></div>`;
        });
    }

    // Location details
    const addr = [d.address, d.city, d.state, d.zipCode].filter(Boolean).join(', ');
    if (addr) html += buildInfoFull('Location', addr);

    // Edit mode fields
    if (options.editMode && options.isOwner) {
        const bef = options.buildEditableField;
        if (bef) {
            html += `<div class="entity-detail-section-title">Edit Fields</div>`;
            html += bef(d, 'title', 'Title', d.title, false);
            html += bef(d, 'email', 'Email', d.email, false);
            html += bef(d, 'phone', 'Phone', d.phone, false);
            html += bef(d, 'website', 'Website', d.website, false);
            html += bef(d, 'applicationLink', 'Application Link', d.applicationLink, false);
            html += bef(d, 'directorName', 'Director Name', d.directorName, false);
            html += bef(d, 'communityName', 'Community Name', d.communityName, false);
        }
    }

    return html;
}

export function renderCampus(d, options) {
    let html = '';
    if (d.university) html += buildInfoFull('University', d.university);
    if (d.organization) html += buildInfoFull('Organization', d.organization);
    if (d.type && d.type !== d._type) html += buildInfoFull('Type', d.type);
    if (d.meetingTimes || d.meetingTime) html += buildInfoFull('Meeting Times', d.meetingTimes || d.meetingTime);
    if (d.chaplainName) html += buildInfoFull('Chaplain', d.chaplainName + (d.chaplainEmail ? ' · ' + d.chaplainEmail : ''));
    if (d.introduction) html += buildInfoFull('About', d.introduction);
    if (d.parishAddress) html += buildInfoFull('Parish Address', d.parishAddress);
    if (d.memberCount) html += buildInfoItem('Members', d.memberCount);

    // Social
    if (d.socialMedia && typeof d.socialMedia === 'object') html += buildSocialMedia(d.socialMedia);

    return html;
}

// ── Main renderer ─────────────────────────────────────

/**
 * renderEntityDetailHTML(d, options) — returns the full HTML string for the detail panel.
 *
 * options: {
 *   isOwner: false,
 *   editMode: false,
 *   isFavorited: false,
 *   onShare: null,        // onclick name string for share, e.g. 'shareEntity()'
 *   onNotify: null,       // onclick name string
 *   onFollow: null,       // onclick for follow key
 *   onSave: null,         // onclick for save/favorite
 *   onMessage: null,      // onclick for message owner
 *   onDelete: null,       // onclick for delete
 *   showEditBar: false,
 *   buildEditableField: null, // function(d, field, label, val, isTextarea) => html
 * }
 */
export function renderEntityDetailHTML(d, options) {
    const opts = Object.assign({
        isOwner: false,
        editMode: false,
        isFavorited: false,
        onShare: null,
        onNotify: null,
        onFollow: null,
        onSave: null,
        onMessage: null,
        onDelete: null,
        showEditBar: false,
        buildEditableField: null
    }, options || {});

    const type = d._type;

    // Hero image at top
    let html = buildHeroImage(d);

    // Owner edit bar
    if (opts.showEditBar) {
        html += buildEditBar(d, opts);
    }

    // ── Rainbow hero card (name inside card for all types) ──
    const cardClass = 'entity-detail-card rainbow';
    let cardHTML = '';

    // Name at top of rainbow card
    const name = d.name || d.parishName || d.title || 'Unknown';
    cardHTML += `<div style="font-size:1.35rem;font-weight:700;color:#111;margin-bottom:6px;">${escapeHTML(name)}</div>`;

    // Address line (street only for churches, full for others)
    if (type === 'church') {
        const addr = d.address || '';
        const street = addr.includes(',') ? addr.split(',')[0].trim() : addr;
        if (street) cardHTML += `<div style="font-size:0.92rem;color:#888;margin-bottom:8px;">${escapeHTML(street)}</div>`;
    } else {
        cardHTML += buildLocation(d);
    }

    // Rating row (business)
    if (d.rating) {
        let ratingHTML = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;"><span style="color:#EAB308;font-size:0.92rem;">★</span><span style="font-size:0.92rem;font-weight:600;color:#111;">${d.rating}</span>`;
        if (d.reviewCount) ratingHTML += `<span style="font-size:0.78rem;color:#888;">(${d.reviewCount} reviews)</span>`;
        ratingHTML += `</div>`;
        cardHTML += ratingHTML;
    }

    // Category + subcategory (business)
    if (d.category || d.subcategory) {
        const parts = [d.category, d.subcategory].filter(Boolean);
        cardHTML += `<div style="font-size:0.88rem;color:#888;margin-bottom:6px;">${escapeHTML(parts.join(' · '))}</div>`;
    }

    // Founding year
    if (d.foundingYear) cardHTML += `<div style="display:flex;align-items:center;gap:6px;font-size:0.82rem;color:#777;margin-bottom:6px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>Since ${escapeHTML(String(d.foundingYear))}</div>`;

    // Feature pills (business — top 3)
    if (Array.isArray(d.features) && d.features.length > 0) {
        cardHTML += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">`;
        d.features.slice(0, 3).forEach(f => {
            const text = typeof f === 'object' ? (f.name || f.title || '') : f;
            if (text) cardHTML += `<span style="font-size:0.72rem;padding:4px 10px;border-radius:20px;background:rgba(139,92,45,0.1);color:#8B5C2D;">${escapeHTML(text)}</span>`;
        });
        cardHTML += `</div>`;
    }

    // Description (inside rainbow card for all types that have one)
    const desc = d.description || d.bio || '';
    if (desc) {
        if (opts.editMode && opts.isOwner) {
            cardHTML += (opts.buildEditableField ? opts.buildEditableField(d, 'description', 'Description', desc, true) : '');
        } else {
            const truncated = desc.length > 300 ? desc.substring(0, 297) + '...' : desc;
            cardHTML += `<div style="border-top:1px solid #eee;margin:8px 0;"></div>`;
            cardHTML += `<div class="entity-detail-description">${escapeHTML(truncated)}</div>`;
        }
    }

    // Website (bottom-left) + Gallery icon (bottom-right) — matches iOS
    const website = d.website || d.websiteURL || d.link || d.contactInfo?.website || '';
    cardHTML += `<div class="entity-detail-website-row">`;
    if (website) {
        const url = website.startsWith('http') ? website : 'https://' + website;
        cardHTML += `<a href="${url}" target="_blank" rel="noopener" class="entity-detail-website-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>Visit Website</a>`;
    } else {
        cardHTML += `<span class="entity-detail-website-link disabled"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>Visit Website</span>`;
    }
    cardHTML += `<div class="entity-detail-gallery-icon" onclick="openGalleryLightbox()" title="Photo Gallery"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 22H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2z"/><path d="M22 4v12a2 2 0 0 1-2 2"/><path d="M6 2h14a2 2 0 0 1 2 2v0"/><circle cx="10" cy="13" r="2"/><path d="M2 20l5-5a2 2 0 0 1 2.8 0L14 19"/></svg></div>`;
    cardHTML += `</div>`;

    html += `<div class="${cardClass}">${cardHTML}</div>`;

    // ── LOCKED CHURCH: show upsell instead of full content (matches iOS PrimeParishDetailView) ──
    const isLockedChurch = type === 'church' && d.isUnlocked !== true;
    if (isLockedChurch) {
        html += renderLockedChurch(d);
        // Locked view: only contact + footer, no follow/actions/sections
        html += buildFooter(d);
        return html;
    }

    // ── Follow Key button ──
    const onFollowStr = opts.onFollow ? `onclick="${opts.onFollow}"` : `onclick="toggleFollowKey()"`;
    html += `<button class="entity-detail-follow-btn" id="detail-follow-btn" ${onFollowStr}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>Follow Key</button>`;

    // ── 3 Quick Action Buttons (type-specific, matches iOS) ──
    const mapsUrl = buildMapsUrl(d);
    const shareOnclick = opts.onShare ? `onclick="${opts.onShare}"` : `onclick="shareEntity()"`;
    const notifyOnclick = opts.onNotify ? `onclick="${opts.onNotify}"` : `onclick="notifyEntity()"`;
    const saveOnclick = opts.onSave ? `onclick="${opts.onSave}"` : `onclick="toggleFavorite()"`;
    const messageOnclick = opts.onMessage ? `onclick="${opts.onMessage}"` : `onclick="messageEntityOwner()"`;

    const QA_SHARE = `<button class="entity-detail-quick-action" ${shareOnclick}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg><span>Share</span></button>`;
    const QA_NOTIFY = `<button class="entity-detail-quick-action" ${notifyOnclick}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><span>Notify</span></button>`;
    const QA_MAP = mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener" class="entity-detail-quick-action"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><span>Map</span></a>` : `<button class="entity-detail-quick-action" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><span>Map</span></button>`;
    const QA_SAVE = `<button class="entity-detail-quick-action" id="detail-qa-save-btn" ${saveOnclick}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg><span>${opts.isFavorited ? 'Saved' : 'Save'}</span></button>`;
    const QA_MESSAGE = `<button class="entity-detail-quick-action" ${messageOnclick}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>Message</span></button>`;
    const applyUrl = d.applicationLink || d.enrollmentURL || '';
    const QA_APPLY = applyUrl ? `<a href="${applyUrl}" target="_blank" rel="noopener" class="entity-detail-quick-action"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg><span>Apply</span></a>` : `<button class="entity-detail-quick-action" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>Apply</span></button>`;
    const donateUrl = d.donationLink || '';
    const QA_DONATE = donateUrl ? `<a href="${donateUrl}" target="_blank" rel="noopener" class="entity-detail-quick-action"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg><span>Donate</span></a>` : `<button class="entity-detail-quick-action" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg><span>Donate</span></button>`;

    html += `<div class="entity-detail-quick-actions">`;
    if (type === 'church') {
        html += QA_SHARE + QA_NOTIFY + QA_MAP;
    } else if (type === 'school' || type === 'vocation') {
        html += QA_SAVE + QA_MESSAGE + QA_APPLY;
    } else if (type === 'missionary') {
        html += QA_SAVE + QA_MESSAGE + QA_DONATE;
    } else {
        // business, retreat, pilgrimage, campus
        html += QA_SAVE + QA_MESSAGE + QA_MAP;
    }
    html += `</div>`;

    // ── Type-specific sections ──
    switch (type) {
        case 'church': html += renderChurch(d, opts); break;
        case 'business': html += renderBusiness(d, opts); break;
        case 'school': html += renderSchool(d, opts); break;
        case 'missionary': html += renderMissionary(d, opts); break;
        case 'retreat': html += renderRetreat(d, opts); break;
        case 'pilgrimage': html += renderPilgrimage(d, opts); break;
        case 'vocation': html += renderVocation(d, opts); break;
        case 'campus': html += renderCampus(d, opts); break;
    }

    // Contact + footer
    html += `<div class="entity-detail-section-title">Contact</div>`;
    html += buildContact(d);
    html += buildFooter(d);

    return html;
}

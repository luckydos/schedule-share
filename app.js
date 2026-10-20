// Firebase v13.0.0 Modular SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
	getAuth,
	signInWithEmailAndPassword,
	signOut,
	onAuthStateChanged,
	updatePassword,
	EmailAuthProvider,
	reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
	getFirestore,
	doc,
	getDoc,
	setDoc,
	updateDoc,
	deleteField,
	collection,
	onSnapshot,
	serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

// --- 1. Firebase 초기 설정 ---
const firebaseConfig = {
	apiKey: "AIzaSyAeMuTbbMcVypAL3KNk0Y2jYb5dO2HvQCc",
	authDomain: "schedule-share-f059f.firebaseapp.com",
	projectId: "schedule-share-f059f",
	storageBucket: "schedule-share-f059f.firebasestorage.app",
	messagingSenderId: "932233793112",
	appId: "1:932233793112:web:038084057bb92ef666842d"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// 팀 전용 가상 도메인 정의
const VIRTUAL_DOMAIN = "@scheduleshare.local";

// 전역 상태
let currentUser = null;
let currentUserProfile = null;
let teamUsersMap = {}; // 팀원 전체 실시간 프로필 캐시 { UID: { displayName, email } }
let calendar = null;
let scheduleRecords = {};
let selectedDateStr = null;
let editingEntryId = null;
let unsubscribeFirestore = null;
let unsubscribeUsers = null;

// DOM 요소 캐싱
const authOverlay = document.getElementById("auth-overlay");
const authLoadingBox = document.getElementById("auth-loading-box");
const authLoginBox = document.getElementById("auth-login-box");
const loginEmailInput = document.getElementById("login-email");
const loginPasswordInput = document.getElementById("login-password");
const btnLogin = document.getElementById("btn-login");
const loginErrEl = document.getElementById("login-error");
const btnLogout = document.getElementById("btn-logout");
const currentUserDisplay = document.getElementById("current-user-display");

const scheduleModal = document.getElementById("schedule-modal");
const modalCloseBtn = document.getElementById("modal-close");
const teamScheduleList = document.getElementById("team-schedule-list");
const modalDateTitle = document.getElementById("modal-date-title");
const myFormTitle = document.getElementById("my-form-title");
const scheduleFormWrapper = document.getElementById("schedule-form-wrapper");
const scheduleCategory = document.getElementById("schedule-category");
const scheduleMemo = document.getElementById("schedule-memo");
const formActionsCreate = document.getElementById("form-actions-create");
const formActionsEdit = document.getElementById("form-actions-edit");
const btnSaveSchedule = document.getElementById("btn-save-schedule");
const btnUpdateSchedule = document.getElementById("btn-update-schedule");
const btnCancelEdit = document.getElementById("btn-cancel-edit");

const profileModal = document.getElementById("profile-modal");
const btnProfile = document.getElementById("btn-profile");
const profileModalClose = document.getElementById("profile-modal-close");
const profDisplayName = document.getElementById("prof-displayname");
const profUserId = document.getElementById("prof-userid");
const profNewPass = document.getElementById("prof-new-pass");
const profCurrentPass = document.getElementById("prof-current-pass");
const lblCurrentPass = document.getElementById("lbl-current-pass");
const btnSaveProfile = document.getElementById("btn-save-profile");
const profileStatus = document.getElementById("profile-status");

// --- 2. FullCalendar 초기화 ---
const calendarEl = document.getElementById("calendar");

calendar = new FullCalendar.Calendar(calendarEl, {
	initialView: "dayGridMonth",
	locale: "ko",
	headerToolbar: {
		left: "prev,next today",
		center: "title",
		right: ""
	},
	buttonText: {
		today: "오늘"
	},
	height: "100%",
	expandRows: true,
	fixedWeekCount: false,
	showNonCurrentDates: false,
	selectable: false,
	editable: false,
	eventStartEditable: false,
	longPressDelay: 0,
	selectLongPressDelay: 0,
	datesSet: function () {
		updateTodayButtonState();
		calculateStatistics();
	},
	dayCellDidMount: function (arg) {
		renderDayCellBadge(arg.date, arg.el);
	}
});

calendar.render();

// 🔥 원터치 인터셉트 감지기
let clickStartX = 0;
let clickStartY = 0;

calendarEl.addEventListener("pointerdown", (e) => {
	clickStartX = e.clientX;
	clickStartY = e.clientY;
}, { capture: true, passive: true });

calendarEl.addEventListener("pointerup", (e) => {
	if (e.target.closest(".fc-toolbar")) return;

	const moveX = Math.abs(e.clientX - clickStartX);
	const moveY = Math.abs(e.clientY - clickStartY);

	// 손가락을 거의 움직이지 않은 순수한 '클릭/탭(15px 미만 이동)'인 경우 즉시 모달 오픈
	if (moveX < 15 && moveY < 15) {
		const dayCell = e.target.closest(".fc-daygrid-day");
		if (dayCell) {
			const dateStr = dayCell.getAttribute("data-date");
			if (dateStr && !scheduleModal.classList.contains("active")) {
				e.stopPropagation();
				e.preventDefault();
				openScheduleModal(dateStr);
			}
		}
	}
}, { capture: true });

// '오늘' 버튼 스마트 비활성화
function updateTodayButtonState() {
	const todayBtn = document.querySelector(".fc-today-button");
	if (!todayBtn) return;

	const now = new Date();
	const currentViewDate = calendar.getDate();
	const isCurrentMonth =
		now.getFullYear() === currentViewDate.getFullYear() &&
		now.getMonth() === currentViewDate.getMonth();

	todayBtn.disabled = isCurrentMonth;
}

// --- 3. 날짜 셀 배지 렌더링 (3개 기본 노출 및 중앙 정렬) ---
function renderDayCellBadge(date, cellEl) {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	const dateStr = `${y}-${m}-${d}`;

	const prevBadge = cellEl.querySelector(".badge-container");
	if (prevBadge) prevBadge.remove();
	cellEl.classList.remove("has-schedules");

	const record = scheduleRecords[dateStr];
	if (record && record.totalCount > 0) {
		cellEl.classList.add("has-schedules");

		const badgeContainer = document.createElement("div");
		badgeContainer.className = "badge-container";

		const entries = Object.values(record.entries || {});

		// 기본 카테고리 우선순위 정렬 집계
		const categories = ["휴가", "출장", "교육", "기타"];
		const activeBadges = [];

		categories.forEach(cat => {
			const count = entries.filter(e => e.category === cat).length;
			if (count > 0) {
				activeBadges.push({ category: cat, count: count });
			}
		});

		// 3개(휴가, 출장, 교육 등)까지 기본 출력, 4개부터 축약(+N)
		const MAX_VISIBLE = 3;
		const displayBadges = activeBadges.slice(0, MAX_VISIBLE);
		const overflowCount = activeBadges.length - MAX_VISIBLE;

		displayBadges.forEach(b => {
			const pill = document.createElement("span");
			pill.className = `pill-badge cat-${b.category}`;
			pill.innerText = `${b.category} ${b.count}`;
			badgeContainer.appendChild(pill);
		});

		// 4개 이상일 때 +N 배지 표시
		if (overflowCount > 0) {
			const morePill = document.createElement("span");
			morePill.className = "pill-badge cat-more";
			morePill.innerText = `+${overflowCount}`;
			badgeContainer.appendChild(morePill);
		}

		const frameEl = cellEl.querySelector(".fc-daygrid-day-frame");
		if (frameEl) {
			frameEl.appendChild(badgeContainer);
		}
	}
}

function refreshAllCellBadges() {
	const cells = document.querySelectorAll(".fc-daygrid-day");
	cells.forEach((cell) => {
		const dateStr = cell.getAttribute("data-date");
		if (dateStr) {
			const date = new Date(dateStr + "T00:00:00");
			renderDayCellBadge(date, cell);
		}
	});
	calculateStatistics();
}

// --- 4. 통계 계산 ---
function calculateStatistics() {
	if (!calendar) return;
	const viewDate = calendar.getDate();
	const currentYear = viewDate.getFullYear();
	const currentMonth = viewDate.getMonth() + 1;
	const monthPrefix = `${currentYear}-${String(currentMonth).padStart(2, "0")}`;

	let myCount = 0;
	let teamCount = 0;

	Object.entries(scheduleRecords).forEach(([dateStr, record]) => {
		if (dateStr.startsWith(monthPrefix) && record.entries) {
			const entriesList = Object.values(record.entries);
			teamCount += entriesList.length;
			if (currentUser) {
				const myEntries = entriesList.filter((e) => e.userId === currentUser.uid);
				myCount += myEntries.length;
			}
		}
	});

	document.getElementById("stat-my-count").innerText = `${myCount}건`;
	document.getElementById("stat-team-count").innerText = `${teamCount}건`;
}

// --- 5. Firestore 실시간 동기화 ---
function subscribeSchedules() {
	if (unsubscribeFirestore) unsubscribeFirestore();

	const recordsCol = collection(db, "schedules", "group", "records");
	unsubscribeFirestore = onSnapshot(
		recordsCol,
		(snapshot) => {
			const newRecords = {};
			snapshot.forEach((docSnap) => {
				newRecords[docSnap.id] = docSnap.data();
			});
			scheduleRecords = newRecords;
			refreshAllCellBadges();

			if (selectedDateStr && scheduleModal.classList.contains("active")) {
				renderModalDetail(selectedDateStr);
			}
		},
		(err) => {
			console.error("Firestore 동기화 오류:", err);
		}
	);
}

function subscribeTeamUsers() {
	if (unsubscribeUsers) unsubscribeUsers();

	const usersCol = collection(db, "users");
	unsubscribeUsers = onSnapshot(usersCol, (snapshot) => {
		snapshot.forEach((docSnap) => {
			teamUsersMap[docSnap.id] = docSnap.data();
		});
		if (selectedDateStr && scheduleModal.classList.contains("active")) {
			renderModalDetail(selectedDateStr);
		}
	});
}

// --- 6. 유틸리티 함수 ---
function setButtonLoading(btn, isLoading, loadingText = "처리 중...", originalText = "") {
	if (isLoading) {
		btn.dataset.originalText = btn.innerHTML;
		btn.disabled = true;
		btn.innerHTML = `<span class="spinner"></span>${loadingText}`;
	} else {
		btn.disabled = false;
		btn.innerHTML = originalText || btn.dataset.originalText || "확인";
	}
}

function formatTimeString(isoString) {
	if (!isoString) return "";
	try {
		const d = new Date(isoString);
		if (isNaN(d.getTime())) return "";
		return d.toLocaleTimeString("ko-KR", {
			hour: "2-digit",
			minute: "2-digit",
			hour12: true
		});
	} catch (e) {
		return "";
	}
}

// 공통 모달 열기/닫기 애니메이션 제어
function showModalWithAnimation(modalEl) {
	modalEl.classList.add("is-open");
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			modalEl.classList.add("active");
		});
	});
}

function hideModalWithAnimation(modalEl, onComplete) {
	modalEl.classList.remove("active");
	setTimeout(() => {
		modalEl.classList.remove("is-open");
		if (onComplete) onComplete();
	}, 260);
}

// --- 7. 날짜 상세 모달 상호작용 ---
function openScheduleModal(dateStr) {
	selectedDateStr = dateStr;
	modalDateTitle.innerText = `${dateStr} 일정`;
	renderModalDetail(dateStr);

	// 모바일 Ghost Click 방지
	scheduleFormWrapper.style.pointerEvents = "none";
	setTimeout(() => {
		scheduleFormWrapper.style.pointerEvents = "auto";
	}, 200);

	showModalWithAnimation(scheduleModal);

	if (document.activeElement) {
		document.activeElement.blur();
	}
}

function closeScheduleModal() {
	hideModalWithAnimation(scheduleModal, () => {
		selectedDateStr = null;
		resetScheduleForm();
	});
}

function resetScheduleForm() {
	editingEntryId = null;
	myFormTitle.textContent = "새 일정 추가";
	scheduleCategory.value = "휴가";
	scheduleMemo.value = "";
	formActionsCreate.style.display = "flex";
	formActionsEdit.style.display = "none";

	// 목록의 모든 카드에서 수정 중 하이라이트 해제 및 버튼 복원
	document.querySelectorAll(".schedule-item").forEach((item) => {
		item.classList.remove("is-editing");
		const editBtn = item.querySelector(".btn-item-edit");
		if (editBtn) {
			editBtn.textContent = "수정";
			editBtn.disabled = false;
		}
	});
}

function setFormToEditMode(entry) {
	editingEntryId = entry.id;
	myFormTitle.textContent = "선택한 일정 수정";
	scheduleCategory.value = entry.category || "휴가";
	scheduleMemo.value = entry.title || "";
	formActionsCreate.style.display = "none";
	formActionsEdit.style.display = "flex";

	// 상단 카드 목록 시각 피드백: 선택된 카드 배경 틴트 전환 및 버튼 텍스트 변경
	document.querySelectorAll(".schedule-item").forEach((item) => {
		const isTarget = item.getAttribute("data-entry-id") === String(entry.id);
		item.classList.toggle("is-editing", isTarget);

		const editBtn = item.querySelector(".btn-item-edit");
		if (editBtn) {
			if (isTarget) {
				editBtn.textContent = "수정 중";
				editBtn.disabled = true;
			} else {
				editBtn.textContent = "수정";
				editBtn.disabled = false;
			}
		}
	});

	scheduleMemo.focus();
}

function renderModalDetail(dateStr) {
	const record = scheduleRecords[dateStr];
	teamScheduleList.innerHTML = "";
	resetScheduleForm();

	if (record && record.entries && Object.keys(record.entries).length > 0) {
		const entriesList = Object.entries(record.entries).map(([key, item]) => {
			return {
				...item,
				id: item.id || key
			};
		});

		entriesList.sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0));

		entriesList.forEach((entry) => {
			const isMyEntry = currentUser && (entry.userId === currentUser.uid || entry.id === currentUser.uid);

			const item = document.createElement("div");
			item.className = "schedule-item";
			item.setAttribute("data-entry-id", String(entry.id));

			if (isMyEntry) {
				item.style.borderColor = "#c7d2fe"; // 본인 일정은 부드러운 테두리 유지
			}

			const headerDiv = document.createElement("div");
			headerDiv.style.display = "flex";
			headerDiv.style.justifyContent = "space-between";
			headerDiv.style.alignItems = "center";

			const metaDiv = document.createElement("div");
			metaDiv.className = "schedule-meta";

			// 1. 구분 배지
			const tagSpan = document.createElement("span");
			tagSpan.className = "tag tag-" + (entry.category || "기타");
			tagSpan.textContent = entry.category || "기타";
			metaDiv.appendChild(tagSpan);

			// 2. 팀원 이름 (최신 닉네임 실시간 매핑)
			const userProfile = teamUsersMap[entry.userId];
			const latestName = (userProfile && userProfile.displayName) || entry.userName || (entry.userId ? entry.userId : "팀원");

			const nameSpan = document.createElement("span");
			nameSpan.className = "member-name";
			nameSpan.textContent = latestName + (isMyEntry ? " (나)" : "");
			metaDiv.appendChild(nameSpan);

			// 3. 등록/수정 시간
			const timeFormatted = formatTimeString(entry.updatedAt);
			if (timeFormatted) {
				const timeSpan = document.createElement("span");
				timeSpan.className = "schedule-time";
				timeSpan.textContent = timeFormatted;
				metaDiv.appendChild(timeSpan);
			}

			headerDiv.appendChild(metaDiv);

			// 본인 일정에만 수정/삭제 버튼 제공
			if (isMyEntry) {
				const actionGroup = document.createElement("div");
				actionGroup.style.display = "flex";
				actionGroup.style.gap = "6px";

				const editBtn = document.createElement("button");
				editBtn.className = "btn btn-item-edit";
				editBtn.style.padding = "2px 8px";
				editBtn.style.fontSize = "0.75rem";
				editBtn.textContent = "수정";
				editBtn.onclick = (e) => {
					e.stopPropagation();
					setFormToEditMode(entry);
				};

				const delBtn = document.createElement("button");
				delBtn.className = "btn btn-danger";
				delBtn.style.padding = "2px 8px";
				delBtn.style.fontSize = "0.75rem";
				delBtn.textContent = "삭제";
				delBtn.onclick = (e) => {
					e.stopPropagation();
					deleteSpecificSchedule(entry.id);
				};

				actionGroup.appendChild(editBtn);
				actionGroup.appendChild(delBtn);
				headerDiv.appendChild(actionGroup);
			}

			item.appendChild(headerDiv);

			// 메모 내용
			const memoDiv = document.createElement("div");
			memoDiv.className = "schedule-memo";
			if (entry.title && entry.title.trim() !== "") {
				memoDiv.textContent = entry.title;
			} else {
				memoDiv.textContent = "작성된 메모가 없습니다.";
				memoDiv.classList.add("empty");
			}
			item.appendChild(memoDiv);

			teamScheduleList.appendChild(item);
		});
	} else {
		teamScheduleList.innerHTML = '<div class="empty-state">해당 일자에 등록된 일정이 없습니다.</div>';
	}
}

// 일정 추가 및 수정 처리
async function saveSchedule(event) {
	if (!currentUser || !selectedDateStr) return;

	const btn = event.currentTarget;
	const category = scheduleCategory.value;
	const memo = scheduleMemo.value.trim();
	const userName =
		(currentUserProfile && currentUserProfile.displayName) ||
		currentUser.email.split("@")[0];

	const recordRef = doc(db, "schedules", "group", "records", selectedDateStr);
	const existingRecord = scheduleRecords[selectedDateStr] || { totalCount: 0, entries: {} };

	const isNew = !editingEntryId;
	const entryId = editingEntryId || `entry_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

	const entryData = {
		id: entryId,
		userId: currentUser.uid,
		userName: userName,
		category: category,
		title: memo,
		updatedAt: new Date().toISOString()
	};

	setButtonLoading(btn, true, isNew ? "추가 중..." : "수정 중...");

	try {
		const newTotalCount = isNew
			? (existingRecord.totalCount || 0) + 1
			: existingRecord.totalCount;

		if (!scheduleRecords[selectedDateStr]) {
			await setDoc(recordRef, {
				date: selectedDateStr,
				totalCount: 1,
				entries: {
					[entryId]: entryData
				}
			});
		} else {
			await updateDoc(recordRef, {
				[`entries.${entryId}`]: entryData,
				totalCount: newTotalCount
			});
		}

		resetScheduleForm();
	} catch (err) {
		console.error("일정 저장 오류:", err);
		alert("일정 저장에 실패했습니다.");
	} finally {
		setButtonLoading(btn, false, "", isNew ? "일정 추가" : "수정 완료");
	}
}

// 특정 일정 개별 삭제
async function deleteSpecificSchedule(entryId) {
	if (!currentUser || !selectedDateStr || !entryId) return;
	if (!confirm("해당 일정을 삭제하시겠습니까?")) return;

	const recordRef = doc(db, "schedules", "group", "records", selectedDateStr);
	const existingRecord = scheduleRecords[selectedDateStr];

	if (!existingRecord || !existingRecord.entries || !existingRecord.entries[entryId]) return;

	try {
		const newTotalCount = Math.max(0, (existingRecord.totalCount || 1) - 1);
		await updateDoc(recordRef, {
			[`entries.${entryId}`]: deleteField(),
			totalCount: newTotalCount
		});

		if (editingEntryId === entryId) {
			resetScheduleForm();
		}
	} catch (err) {
		console.error("일정 삭제 오류:", err);
		alert("일정 삭제에 실패했습니다.");
	}
}

// 모달 이벤트 리스너 연결
btnSaveSchedule.addEventListener("click", saveSchedule);
btnUpdateSchedule.addEventListener("click", saveSchedule);
btnCancelEdit.addEventListener("click", resetScheduleForm);
modalCloseBtn.addEventListener("click", closeScheduleModal);

// 모달 외부(백드롭) 클릭 시 닫기
let modalMousedownTarget = null;
scheduleModal.addEventListener("mousedown", (e) => {
	modalMousedownTarget = e.target;
});
scheduleModal.addEventListener("touchstart", (e) => {
	modalMousedownTarget = e.target;
}, { passive: true });

scheduleModal.addEventListener("mouseup", (e) => {
	if (modalMousedownTarget === scheduleModal && e.target === scheduleModal) {
		closeScheduleModal();
	}
	modalMousedownTarget = null;
});
scheduleModal.addEventListener("touchend", (e) => {
	if (modalMousedownTarget === scheduleModal && e.target === scheduleModal) {
		closeScheduleModal();
	}
	modalMousedownTarget = null;
});

// --- 8. 사용자 프로필 및 계정 설정 ---
async function loadUserProfile(uid) {
	try {
		const userDocRef = doc(db, "users", uid);
		const userSnap = await getDoc(userDocRef);
		if (userSnap.exists()) {
			currentUserProfile = userSnap.data();
		} else {
			currentUserProfile = {
				displayName: currentUser.email.split("@")[0],
				email: currentUser.email
			};
			await setDoc(userDocRef, currentUserProfile);
		}
		currentUserDisplay.innerText = `${currentUserProfile.displayName} 님`;
	} catch (err) {
		console.error("프로필 로드 오류:", err);
	}
}

function toggleCurrentPasswordField() {
	const hasNewPass = profNewPass.value.trim().length > 0;

	if (hasNewPass) {
		profCurrentPass.disabled = false;
		profCurrentPass.placeholder = "본인 확인을 위해 현재 비밀번호를 입력하세요";
		lblCurrentPass.style.color = "var(--danger)";
		lblCurrentPass.style.fontWeight = "700";
	} else {
		profCurrentPass.disabled = true;
		profCurrentPass.value = "";
		profCurrentPass.placeholder = "새 비밀번호를 입력하면 활성화됩니다";
		lblCurrentPass.style.color = "var(--text-muted)";
		lblCurrentPass.style.fontWeight = "600";
	}
}

profNewPass.addEventListener("input", toggleCurrentPasswordField);

// 설정 모달 열기
btnProfile.addEventListener("click", () => {
	if (!currentUser) return;
	profDisplayName.value = (currentUserProfile && currentUserProfile.displayName) || "";
	profUserId.value = currentUser.email ? currentUser.email.split("@")[0] : "";
	profNewPass.value = "";
	profCurrentPass.value = "";
	toggleCurrentPasswordField();
	profileStatus.innerText = "";
	showModalWithAnimation(profileModal);
});

profileModalClose.addEventListener("click", () => {
	hideModalWithAnimation(profileModal);
});

// 설정 모달 외부 클릭 시 닫기
let profileMousedownTarget = null;
profileModal.addEventListener("mousedown", (e) => {
	profileMousedownTarget = e.target;
});
profileModal.addEventListener("touchstart", (e) => {
	profileMousedownTarget = e.target;
}, { passive: true });

profileModal.addEventListener("mouseup", (e) => {
	if (profileMousedownTarget === profileModal && e.target === profileModal) {
		hideModalWithAnimation(profileModal);
	}
	profileMousedownTarget = null;
});
profileModal.addEventListener("touchend", (e) => {
	if (profileMousedownTarget === profileModal && e.target === profileModal) {
		hideModalWithAnimation(profileModal);
	}
	profileMousedownTarget = null;
});

// 설정 저장
btnSaveProfile.addEventListener("click", async () => {
	const displayName = profDisplayName.value.trim();
	const newPass = profNewPass.value;
	const currentPass = profCurrentPass.value;

	profileStatus.className = "status-msg";
	profileStatus.innerText = "처리 중...";

	try {
		if (newPass) {
			if (!currentPass) {
				profileStatus.style.color = "var(--danger)";
				profileStatus.innerText = "비밀번호를 변경하려면 현재 비밀번호를 입력해주세요.";
				return;
			}
			if (newPass.length < 6) {
				profileStatus.style.color = "var(--danger)";
				profileStatus.innerText = "새 비밀번호는 6자리 이상이어야 합니다.";
				return;
			}

			const credential = EmailAuthProvider.credential(currentUser.email, currentPass);
			await reauthenticateWithCredential(currentUser, credential);
			await updatePassword(currentUser, newPass);
		}

		currentUserProfile = {
			...currentUserProfile,
			displayName: displayName || currentUser.email.split("@")[0],
			email: currentUser.email,
			updatedAt: serverTimestamp()
		};
		await setDoc(doc(db, "users", currentUser.uid), currentUserProfile, { merge: true });

		currentUserDisplay.innerText = `${currentUserProfile.displayName} 님`;
		profileStatus.style.color = "green";
		profileStatus.innerText = "저장되었습니다.";

		setTimeout(() => {
			hideModalWithAnimation(profileModal);
		}, 700);
	} catch (err) {
		console.error("설정 수정 오류:", err);
		profileStatus.style.color = "var(--danger)";
		if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
			profileStatus.innerText = "현재 비밀번호가 일치하지 않습니다.";
		} else {
			profileStatus.innerText = "수정 중 오류가 발생했습니다.";
		}
	}
});

// --- 9. 인증 상태 리스너 ---
onAuthStateChanged(auth, async (user) => {
	if (user) {
		currentUser = user;
		await loadUserProfile(user.uid);
		subscribeTeamUsers();
		subscribeSchedules();

		authOverlay.classList.add("is-hidden");

		if (calendar) {
			calendar.render();
			updateTodayButtonState();
		}
	} else {
		currentUser = null;
		currentUserProfile = null;
		if (unsubscribeFirestore) unsubscribeFirestore();
		if (unsubscribeUsers) unsubscribeUsers();

		authLoadingBox.classList.add("is-hidden");
		authLoginBox.classList.remove("is-hidden");
		authOverlay.classList.remove("is-hidden");

		setTimeout(() => {
			loginEmailInput.focus();
		}, 100);
	}
});

// --- 10. 로그인 / 로그아웃 핸들러 ---
btnLogin.addEventListener("click", async () => {
	const idInput = loginEmailInput.value.trim();
	const pass = loginPasswordInput.value;

	loginErrEl.classList.add("is-hidden");

	if (!idInput || !pass) {
		loginErrEl.classList.remove("is-hidden");
		loginErrEl.innerText = "아이디와 비밀번호를 모두 입력해주세요.";
		return;
	}

	const emailToSend = idInput.includes("@") ? idInput : `${idInput}${VIRTUAL_DOMAIN}`;

	setButtonLoading(btnLogin, true, "로그인 중...");

	try {
		await signInWithEmailAndPassword(auth, emailToSend, pass);
	} catch (err) {
		console.error("로그인 실패:", err);
		setButtonLoading(btnLogin, false, "", "로그인");

		loginErrEl.classList.remove("is-hidden");
		if (
			err.code === "auth/user-not-found" ||
			err.code === "auth/wrong-password" ||
			err.code === "auth/invalid-credential"
		) {
			loginErrEl.innerText = "아이디 또는 비밀번호가 올바르지 않습니다.";
		} else if (err.code === "auth/too-many-requests") {
			loginErrEl.innerText = "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.";
		} else {
			loginErrEl.innerText = "로그인 중 오류가 발생했습니다. 다시 시도해주세요.";
		}
	}
});

const triggerLoginOnEnter = (event) => {
	if (event.key === "Enter") {
		event.preventDefault();
		btnLogin.click();
	}
};
loginEmailInput.addEventListener("keydown", triggerLoginOnEnter);
loginPasswordInput.addEventListener("keydown", triggerLoginOnEnter);

btnLogout.addEventListener("click", () => {
	signOut(auth);
});
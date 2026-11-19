package main

import (
	"fmt"
	"strings"
)

// 和 PHP 的 DomainException 一樣：業務規則被違反，回 {"error": 代碼, "message": 說明}，預設 422
type domainError struct {
	status  int
	reason  string
	message string
}

func (e *domainError) Error() string { return e.reason + ": " + e.message }

func domainErr(reason, message string, status ...int) *domainError {
	s := 422
	if len(status) > 0 {
		s = status[0]
	}
	if message == "" {
		message = reason
	}
	return &domainError{s, reason, message}
}

// 和 Laravel 一樣的驗證錯誤：422 {"message": 第一個錯誤 (and N more errors), "errors": {欄位: [訊息]}}
type validationError struct {
	fields []string
	errors map[string][]string
}

func (v *validationError) Error() string { return v.message() }

func (v *validationError) add(field, msg string) {
	if v.errors == nil {
		v.errors = map[string][]string{}
	}
	if _, ok := v.errors[field]; !ok {
		v.fields = append(v.fields, field)
	}
	v.errors[field] = append(v.errors[field], msg)
}

func (v *validationError) message() string {
	if len(v.fields) == 0 {
		return ""
	}
	msg := v.errors[v.fields[0]][0]
	more := -1
	for _, f := range v.fields {
		more += len(v.errors[f])
	}
	switch {
	case more == 1:
		msg += " (and 1 more error)"
	case more > 1:
		msg += fmt.Sprintf(" (and %d more errors)", more)
	}
	return msg
}

func (v *validationError) failed() bool { return len(v.fields) > 0 }

func attr(field string) string { return strings.ReplaceAll(field, "_", " ") }

// tests/fixtures/sample.go
package main

import "fmt"

// Greet greets a user by name.
func Greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}

// UserService handles user operations.
type UserService struct{}

// CreateUser creates a new user.
func (s *UserService) CreateUser(name, email string) (User, error) {
	validated, err := ValidateEmail(email)
	if err != nil {
		return User{}, err
	}
	return User{Name: name, Email: validated}, nil
}

// ValidateEmail validates an email address.
func ValidateEmail(email string) (string, error) {
	for _, c := range email {
		if c == '@' {
			return email, nil
		}
	}
	return "", fmt.Errorf("invalid email")
}

type User struct {
	Name  string
	Email string
}
